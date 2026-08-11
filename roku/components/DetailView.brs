sub init()
    m.poster = m.top.findNode("poster")
    m.title = m.top.findNode("title")
    m.meta = m.top.findNode("meta")
    m.synopsisHeading = m.top.findNode("synopsisHeading")
    m.synopsis = m.top.findNode("synopsis")
    m.actions = m.top.findNode("actions")

    m.actions.observeField("buttonSelected", "onButtonSelected")
    m.top.playbackHints = {}
end sub

' Called through callFunc, which always passes an argument.
sub activate(args as Dynamic)
    m.actions.focusButton = 0
    m.actions.setFocus(true)
end sub

sub onItemChanged()
    item = m.top.item
    if item = invalid then return

    m.poster.uri = ItemPoster(item)
    m.title.text = item.title

    ' Everything the grid already knows, on screen straight away — the info
    ' call below fills in the rest a moment later.
    m.meta.text = JoinParts([item.genre, RatingText(item.rating)], "  ·  ")
    m.synopsis.text = "Loading details…"
    m.synopsisHeading.visible = true
    m.top.playbackHints = {}

    renderButtons()
    fetchInfo(item.itemId)
end sub

sub onFavoriteChanged()
    renderButtons()
end sub

sub renderButtons()
    favLabel = "Add to favorites"
    if m.top.isFavorite then favLabel = "Remove from favorites"
    m.actions.buttons = ["Play", favLabel]
end sub

sub onButtonSelected(event as Object)
    index = event.getData()
    if index = 0 then
        m.top.playPressed = m.top.playPressed + 1
    else if index = 1 then
        m.top.favPressed = m.top.favPressed + 1
    end if
end sub

sub fetchInfo(vodId as String)
    if vodId = "" then return

    ' A fresh task per lookup: a Task node can only be running once, and the
    ' user can page through detail screens faster than the Pi answers.
    m.infoTask = CreateObject("roSGNode", "RequestTask")
    m.infoTask.request = {
        url: ApiUrl("/api/xtream", { action: "get_vod_info", vod_id: vodId }),
        timeout: 30000
    }
    m.infoTask.tag = vodId
    m.infoTask.observeField("response", "onInfoResponse")
    m.infoTask.control = "RUN"
end sub

sub onInfoResponse(event as Object)
    response = event.getData()
    task = event.getRoSGNode()

    ' The user may have moved on while this was in flight.
    if m.top.item = invalid or task.tag <> m.top.item.itemId then return

    if not response.ok then
        m.synopsis.text = "Couldn't load details: " + response.error
        return
    end if

    info = JsonObject(response).info
    if info = invalid then
        m.synopsis.text = "No synopsis listed for this title."
        return
    end if

    m.meta.text = JoinParts([
        AsText(info.releasedate),
        AsText(info.genre),
        FormatRuntime(info.duration),
        RatingText(AsText(info.rating))
    ], "  ·  ")

    plot = AsText(info.plot)
    if plot = "" then
        m.synopsis.text = "No synopsis listed for this title."
    else
        m.synopsis.text = SafeText(plot)
    end if

    if AsText(info.movie_image) <> "" and m.top.item.logo = "" then
        m.poster.uri = ImageUrl(info.movie_image)
    end if

    m.top.playbackHints = CodecHints(info)
end sub

' get_vod_info carries the provider's ffprobe output. Passing the codecs on to
' /api/remux lets the server pick TS vs fMP4 packaging without probing again —
' and that probe would burn the account's single provider connection.
function CodecHints(info as Object) as Object
    hints = { vcodec: "", acodec: "", achannels: "" }
    if info = invalid then return hints

    if info.video <> invalid then hints.vcodec = AsText(info.video.codec_name)
    if info.audio <> invalid then
        hints.acodec = AsText(info.audio.codec_name)
        hints.achannels = AsText(info.audio.channels)
    end if

    return hints
end function

function RatingText(rating as Dynamic) as String
    text = AsText(rating).Trim()
    if text = "" or text = "0" then return ""
    return text + "/10"
end function
