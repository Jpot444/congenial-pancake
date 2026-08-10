sub init()
    m.poster = m.top.findNode("poster")
    m.title = m.top.findNode("title")
    m.meta = m.top.findNode("meta")
    m.synopsis = m.top.findNode("synopsis")
    m.seasons = m.top.findNode("seasons")
    m.episodes = m.top.findNode("episodes")
    m.status = m.top.findNode("status")
    m.footer = m.top.findNode("footer")

    m.seasons.observeField("itemSelected", "onSeasonSelected")
    m.seasons.observeField("itemFocused", "onSeasonFocused")
    m.episodes.observeField("itemSelected", "onEpisodeSelected")

    ' seasonKey -> ContentNode of that season's episodes, built once when the
    ' series info lands.
    m.seasonContent = {}
    m.seasonKeys = []
end sub

' Called through callFunc, which always passes an argument.
sub activate(args as Dynamic)
    if m.seasons.content <> invalid and m.seasons.content.getChildCount() > 0 then
        m.seasons.setFocus(true)
    else
        m.top.setFocus(true)
    end if
end sub

sub onItemChanged()
    item = m.top.item
    if item = invalid then return

    m.poster.uri = item.posterUrl
    m.title.text = item.title
    m.meta.text = item.genre
    m.synopsis.text = ""

    m.seasons.content = invalid
    m.episodes.content = invalid
    m.seasonContent = {}
    m.seasonKeys = []

    m.status.text = "Loading episodes…"
    m.status.visible = true

    renderFooter()
    fetchSeries(item.itemId)
end sub

sub onFavoriteChanged()
    renderFooter()
end sub

sub renderFooter()
    favHint = "* to favorite the show"
    if m.top.isFavorite then favHint = "* to remove from favorites"
    m.footer.text = "OK to play an episode · " + favHint + " · Back to the grid"
end sub

sub fetchSeries(seriesId as String)
    if seriesId = "" then return

    m.infoTask = CreateObject("roSGNode", "RequestTask")
    m.infoTask.request = {
        url: ApiUrl("/api/xtream", { action: "get_series_info", series_id: seriesId }),
        timeout: 45000
    }
    m.infoTask.tag = seriesId
    m.infoTask.observeField("response", "onSeriesResponse")
    m.infoTask.control = "RUN"
end sub

sub onSeriesResponse(event as Object)
    response = event.getData()
    task = event.getRoSGNode()

    if m.top.item = invalid or task.tag <> m.top.item.itemId then return

    if not response.ok then
        m.status.text = "Couldn't load episodes: " + response.error
        return
    end if

    data = JsonObject(response)
    info = data.info
    if info <> invalid then
        m.meta.text = JoinParts([AsText(info.releaseDate), AsText(info.genre)], "  ·  ")
        m.synopsis.text = AsText(info.plot)
    end if

    episodes = data.episodes
    if episodes = invalid or type(episodes) <> "roAssociativeArray" then
        m.status.text = "No episodes listed for this series."
        return
    end if

    buildSeasons(episodes)
end sub

sub buildSeasons(episodes as Object)
    ' Keys() sorts as text, which puts season 10 between 1 and 2.
    m.seasonKeys = SortedSeasonKeys(episodes.Keys())
    if m.seasonKeys.Count() = 0 then
        m.status.text = "No episodes listed for this series."
        return
    end if

    seasonList = CreateObject("roSGNode", "ContentNode")
    for each key in m.seasonKeys
        rows = episodes[key]
        content = CreateObject("roSGNode", "ContentNode")
        for each episode in rows
            content.appendChild(BuildEpisodeNode(episode, key))
        end for
        m.seasonContent[key] = content

        label = CreateObject("roSGNode", "ContentNode")
        label.title = "Season " + key + "  (" + content.getChildCount().ToStr() + ")"
        seasonList.appendChild(label)
    end for

    m.status.visible = false
    m.seasons.content = seasonList
    m.seasons.jumpToItem = 0
    showSeason(0)
    m.seasons.setFocus(true)
end sub

function BuildEpisodeNode(episode as Object, seasonKey as String) as Object
    node = CreateObject("roSGNode", "ContentNode")
    node.addFields({
        epId: "",
        epNumber: "",
        ext: "",
        vcodec: "",
        acodec: "",
        achannels: "",
        seasonKey: "",
        runtime: ""
    })

    number = AsText(episode.episode_num)
    node.epNumber = number
    node.epId = AsText(episode.id)
    node.seasonKey = seasonKey

    ext = AsText(episode.container_extension)
    if ext = "" then ext = "mp4"
    node.ext = ext

    title = AsText(episode.title)
    if title = "" then title = "Episode " + number
    node.title = title

    info = episode.info
    if info <> invalid then
        node.runtime = FormatRuntime(info.duration)
        if node.runtime = "" then node.runtime = FormatRuntime(info.duration_secs)
        if info.video <> invalid then node.vcodec = AsText(info.video.codec_name)
        if info.audio <> invalid then
            node.acodec = AsText(info.audio.codec_name)
            node.achannels = AsText(info.audio.channels)
        end if
    end if

    return node
end function

' Numeric order, with anything non-numeric (specials are sometimes "0" or a
' name) falling to the end rather than being dropped.
function SortedSeasonKeys(keys as Object) as Object
    numbered = []
    other = []
    for each key in keys
        if IsNumericText(key) then
            numbered.Push(key)
        else
            other.Push(key)
        end if
    end for

    ' Insertion sort: a series has a handful of seasons, not thousands.
    for i = 1 to numbered.Count() - 1
        current = numbered[i]
        value = Val(current)
        j = i - 1
        while j >= 0 and Val(numbered[j]) > value
            numbered[j + 1] = numbered[j]
            j = j - 1
        end while
        numbered[j + 1] = current
    end for

    for each key in other
        numbered.Push(key)
    end for

    return numbered
end function

function IsNumericText(text as String) as Boolean
    if text = "" then return false
    for i = 0 to Len(text) - 1
        ch = Mid(text, i + 1, 1)
        if ch < "0" or ch > "9" then return false
    end for
    return true
end function

sub onSeasonFocused(event as Object)
    showSeason(event.getData())
end sub

sub onSeasonSelected(event as Object)
    showSeason(event.getData())
    if m.episodes.content <> invalid and m.episodes.content.getChildCount() > 0 then
        m.episodes.jumpToItem = 0
        m.episodes.setFocus(true)
    end if
end sub

sub showSeason(index as Integer)
    if index < 0 or index >= m.seasonKeys.Count() then return
    content = m.seasonContent[m.seasonKeys[index]]
    if content = invalid then return
    m.episodes.content = content
end sub

sub onEpisodeSelected(event as Object)
    index = event.getData()
    content = m.episodes.content
    if content = invalid then return

    episode = content.getChild(index)
    if episode = invalid then return

    m.top.selectedEpisode = {
        id: episode.epId,
        ext: episode.ext,
        vcodec: episode.vcodec,
        acodec: episode.acodec,
        achannels: episode.achannels,
        label: "S" + episode.seasonKey + " · E" + episode.epNumber + " — " + episode.title
    }
    m.top.episodePressed = m.top.episodePressed + 1
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false

    if key = "options" then
        m.top.favPressed = m.top.favPressed + 1
        return true
    end if

    ' Left out of the episode list drops back to the season picker rather than
    ' out of the screen entirely.
    if key = "left" and m.episodes.hasFocus() then
        m.seasons.setFocus(true)
        return true
    end if

    if key = "right" and m.seasons.hasFocus() then
        if m.episodes.content <> invalid and m.episodes.content.getChildCount() > 0 then
            m.episodes.setFocus(true)
            return true
        end if
    end if

    return false
end function
