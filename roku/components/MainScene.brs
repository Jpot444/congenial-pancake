' The whole browse experience: tabs, categories, grids, and the handoff into
' detail, series and playback. Anything that touches the network goes out to a
' Task node; this file only ever reacts to what comes back.

sub init()
    m.nav = m.top.findNode("nav")
    m.browse = m.top.findNode("browse")
    m.sectionTitle = m.top.findNode("sectionTitle")
    m.sectionCount = m.top.findNode("sectionCount")
    m.categories = m.top.findNode("categories")
    m.categoryEmpty = m.top.findNode("categoryEmpty")
    m.gridTitle = m.top.findNode("gridTitle")
    m.posterGrid = m.top.findNode("posterGrid")
    m.liveGrid = m.top.findNode("liveGrid")
    m.gridEmpty = m.top.findNode("gridEmpty")
    m.browseHint = m.top.findNode("browseHint")

    m.settings = m.top.findNode("settings")
    m.settingsList = m.top.findNode("settingsList")
    m.settingsNote = m.top.findNode("settingsNote")

    m.detail = m.top.findNode("detail")
    m.series = m.top.findNode("series")
    m.player = m.top.findNode("player")
    m.textEntry = m.top.findNode("textEntry")

    m.loading = m.top.findNode("loading")
    m.loadingText = m.top.findNode("loadingText")
    m.loadingHint = m.top.findNode("loadingHint")
    m.progressTrack = m.top.findNode("progressTrack")
    m.progressFill = m.top.findNode("progressFill")

    m.tabs = ["live", "movies", "series", "favorites", "settings"]
    m.tabLabels = ["Live TV", "Movies", "Series", "Favorites", "Settings"]
    m.section = "live"

    ' section -> catalog root ContentNode, so flipping back to a section you have
    ' already opened is instant.
    m.libraries = {}
    m.libraryTotals = {}
    m.forceRefresh = false

    m.catQuery = ""
    m.categoryIds = []
    m.currentCategoryId = ""

    m.prefs = { pinnedCategories: [], favorites: [] }
    m.favKeys = {}

    m.zone = "nav"
    m.textEntryMode = ""
    m.pendingPlay = invalid
    m.activeRemuxSession = ""

    m.nav.buttons = m.tabLabels
    m.nav.observeField("buttonSelected", "onNavSelected")

    m.categories.observeField("itemSelected", "onCategorySelected")
    m.posterGrid.observeField("itemSelected", "onGridSelected")
    m.liveGrid.observeField("itemSelected", "onGridSelected")
    m.settingsList.observeField("itemSelected", "onSettingsSelected")

    m.detail.observeField("playPressed", "onDetailPlay")
    m.detail.observeField("favPressed", "onDetailFavorite")
    m.series.observeField("episodePressed", "onEpisodePlay")
    m.series.observeField("favPressed", "onSeriesFavorite")
    m.player.observeField("closed", "onPlayerClosed")
    m.player.observeField("playbackError", "onPlaybackError")
    m.textEntry.observeField("text", "onTextEntryChanged")
    m.textEntry.observeField("closeCount", "onTextEntryClosed")

    renderSettings()
    loadPrefs()
    showTab("live")

    ' Somewhere in the scene has to hold focus from the first frame, or the
    ' remote does nothing until the library lands.
    setZone("nav")
end sub

'------------------------------------------------------------------- prefs

sub loadPrefs()
    m.prefsTask = CreateObject("roSGNode", "RequestTask")
    m.prefsTask.request = { url: ApiUrl("/api/prefs", invalid), timeout: 20000 }
    m.prefsTask.observeField("response", "onPrefsResponse")
    m.prefsTask.control = "RUN"
end sub

sub onPrefsResponse(event as Object)
    response = event.getData()
    if not response.ok then
        ' Not fatal: browsing works without pins and favorites. Say so once,
        ' in the hint line, rather than blocking with a dialog.
        m.browseHint.text = "Couldn't load pins and favorites — " + response.error
        return
    end if

    data = JsonObject(response)
    if data.pinnedCategories <> invalid then m.prefs.pinnedCategories = data.pinnedCategories
    if data.favorites <> invalid then m.prefs.favorites = data.favorites

    rebuildFavoriteIndex()
    renderCategories()
    refreshGridFavorites()
    if m.section = "favorites" then renderFavorites()
end sub

' Only the two lists this client owns are sent back. server.js merges a PUT
' field by field, so leaving the rest out keeps the web player's latency mode
' and category filters exactly as they were.
sub savePrefs()
    payload = {
        pinnedCategories: m.prefs.pinnedCategories,
        favorites: m.prefs.favorites
    }

    m.prefsSaveTask = CreateObject("roSGNode", "RequestTask")
    m.prefsSaveTask.request = {
        url: ApiUrl("/api/prefs", invalid),
        method: "PUT",
        body: FormatJson(payload),
        timeout: 20000
    }
    m.prefsSaveTask.observeField("response", "onPrefsSaved")
    m.prefsSaveTask.control = "RUN"
end sub

sub onPrefsSaved(event as Object)
    response = event.getData()
    if not response.ok then
        showDialog("Not saved", "The change didn't reach the Pi: " + response.error)
    end if
end sub

sub rebuildFavoriteIndex()
    m.favKeys = {}
    for each entry in m.prefs.favorites
        key = AsText(entry.key)
        if key <> "" then m.favKeys[key] = true
    end for
end sub

function isPinned(categoryId as String) as Boolean
    key = PinKey(m.section, categoryId)
    for each pin in m.prefs.pinnedCategories
        if AsText(pin) = key then return true
    end for
    return false
end function

sub togglePin(categoryId as String)
    key = PinKey(m.section, categoryId)

    at = -1
    for i = 0 to m.prefs.pinnedCategories.Count() - 1
        if AsText(m.prefs.pinnedCategories[i]) = key then
            at = i
            exit for
        end if
    end for

    if at >= 0 then
        m.prefs.pinnedCategories.Delete(at)
    else
        ' Newest pin first, matching the web player's unshift.
        m.prefs.pinnedCategories.Unshift(key)
    end if

    savePrefs()
    renderCategories()
end sub

sub toggleFavorite(item as Object)
    if item = invalid then return

    key = item.favKey
    at = -1
    for i = 0 to m.prefs.favorites.Count() - 1
        if AsText(m.prefs.favorites[i].key) = key then
            at = i
            exit for
        end if
    end for

    if at >= 0 then
        m.prefs.favorites.Delete(at)
        item.isFavorite = false
    else
        m.prefs.favorites.Unshift({ key: key, item: ItemNodeToRecord(item) })
        item.isFavorite = true
    end if

    ' The server keeps 500; mirror that here so the two clients agree on what
    ' fell off the end.
    while m.prefs.favorites.Count() > 500
        m.prefs.favorites.Delete(m.prefs.favorites.Count() - 1)
    end while

    rebuildFavoriteIndex()
    savePrefs()

    ' Only the view actually showing this title: favoriting a grid item while
    ' a different one sits behind in detail must not relabel that one's button.
    nowFavorite = m.favKeys.DoesExist(key)
    if m.detail.item <> invalid and m.detail.item.favKey = key then m.detail.isFavorite = nowFavorite
    if m.series.item <> invalid and m.series.item.favKey = key then m.series.isFavorite = nowFavorite

    if m.section = "favorites" then renderFavorites()
end sub

'-------------------------------------------------------------------- tabs

sub onNavSelected(event as Object)
    showTab(m.tabs[event.getData()])
end sub

sub showTab(section as String)
    m.section = section
    m.catQuery = ""
    closeOverlays()

    isSettings = (section = "settings")
    m.browse.visible = not isSettings
    m.settings.visible = isSettings

    if isSettings then
        renderSettings()
        m.settingsList.jumpToItem = 0
        setZone("settings")
        return
    end if

    if section = "favorites" then
        m.sectionTitle.text = "Favorites"
        m.categories.visible = false
        m.categoryEmpty.visible = false
        ' No category pane here, so the grid takes the full width.
        m.gridTitle.translation = [60, 228]
        m.posterGrid.translation = [60, 292]
        m.gridEmpty.translation = [60, 300]
        m.posterGrid.numColumns = 7
        m.browseHint.text = "OK to open  ·  * to remove from favorites"
        renderFavorites()
        focusGrid()
        return
    end if

    m.categories.visible = true
    m.gridTitle.translation = [640, 228]
    m.posterGrid.translation = [640, 292]
    m.gridEmpty.translation = [640, 300]
    m.posterGrid.numColumns = 5

    if section = "live" then
        m.sectionTitle.text = "Live TV"
    else if section = "movies" then
        m.sectionTitle.text = "Movies"
    else
        m.sectionTitle.text = "Series"
    end if
    m.browseHint.text = "OK to open  ·  * to pin a category or favorite an item  ·  Back to step out"

    catalog = m.libraries[section]
    if catalog <> invalid and not m.forceRefresh then
        renderCategories()
        setZone("categories")
        return
    end if

    loadLibrary(section)
end sub

'----------------------------------------------------------------- library

sub loadLibrary(section as String)
    m.sectionCount.text = ""
    m.categories.content = invalid
    m.posterGrid.content = invalid
    m.liveGrid.content = invalid
    m.posterGrid.visible = false
    m.liveGrid.visible = false
    m.gridTitle.text = ""
    m.gridEmpty.visible = false

    showLoading("Loading " + m.sectionTitle.text + "…", false)

    m.libraryTask = CreateObject("roSGNode", "LibraryTask")
    m.libraryTask.section = section
    m.libraryTask.refresh = m.forceRefresh
    m.libraryTask.observeField("done", "onLibraryDone")
    m.libraryTask.control = "RUN"
end sub

sub onLibraryDone(event as Object)
    task = event.getRoSGNode()
    if not event.getData() then return

    m.forceRefresh = false

    ' The user may have moved on while this was in flight. Nothing below should
    ' put a dialog over, or a spinner under, a section they already left.
    if task.section <> m.section then
        if task.errorMessage = "" then
            m.libraries[task.section] = task.catalog
            m.libraryTotals[task.section] = task.itemTotal
        end if
        return
    end if

    hideLoading()

    if task.errorMessage <> "" then
        m.gridEmpty.text = task.errorMessage
        m.gridEmpty.visible = true
        gap = Chr(10) + Chr(10)
        detail = task.errorMessage + gap + "Trying: " + ConfigBaseUrl()
        detail = detail + gap + "If that address is wrong, change it under Settings."
        showDialog("Can't load " + m.sectionTitle.text, detail)
        setZone("nav")
        return
    end if

    m.libraries[task.section] = task.catalog
    m.libraryTotals[task.section] = task.itemTotal

    renderCategories()
    setZone("categories")
end sub

'-------------------------------------------------------------- categories

sub renderCategories()
    if m.section = "favorites" or m.section = "settings" then return

    catalog = m.libraries[m.section]
    if catalog = invalid then return

    query = LCase(m.catQuery)

    pinned = []
    rest = []
    for i = 0 to catalog.getChildCount() - 1
        category = catalog.getChild(i)
        if query = "" or Instr(1, LCase(category.title), query) > 0 then
            if isPinned(category.catId) then
                pinned.Push(category)
            else
                rest.Push(category)
            end if
        end if
    end for

    content = CreateObject("roSGNode", "ContentNode")
    m.categoryIds = []

    ' The search row lives in the list itself. A dedicated remote key would be
    ' faster but nothing on screen would ever tell you it existed.
    searchLabel = "Search categories"
    if m.catQuery <> "" then searchLabel = "Search: " + m.catQuery
    content.appendChild(BuildCategoryProxy(searchLabel, "", 0, false, true))
    m.categoryIds.Push("")

    for each category in pinned
        content.appendChild(BuildCategoryProxy(category.title, category.catId, category.itemCount, true, false))
        m.categoryIds.Push(category.catId)
    end for
    for each category in rest
        content.appendChild(BuildCategoryProxy(category.title, category.catId, category.itemCount, false, false))
        m.categoryIds.Push(category.catId)
    end for

    m.categories.content = content

    total = m.libraryTotals[m.section]
    if total = invalid then total = 0
    shown = pinned.Count() + rest.Count()
    m.sectionCount.text = total.ToStr() + " items in " + shown.ToStr() + " categories"

    if shown = 0 then
        m.categoryEmpty.visible = true
        if m.catQuery <> "" then
            m.categoryEmpty.text = "No category matches “" + m.catQuery + "”."
        else
            m.categoryEmpty.text = "No categories came back for this section."
        end if
        clearGrid("Nothing to show here yet.")
        return
    end if

    m.categoryEmpty.visible = false

    ' Keep the open category selected across a re-render (a pin toggle moves
    ' rows around); otherwise start on the first real one.
    target = indexOfCategory(m.currentCategoryId)
    if target < 1 then target = 1
    m.categories.jumpToItem = target

    ' Only rebuild the grid if it is now showing the wrong category. Pinning,
    ' or prefs arriving late, would otherwise scroll the grid back to the top
    ' under someone who is part-way down it.
    wanted = m.categoryIds[target]
    if wanted <> m.currentCategoryId or activeGrid().content = invalid then
        selectCategory(wanted)
    end if
end sub

function indexOfCategory(categoryId as String) as Integer
    if categoryId = "" then return -1
    for i = 0 to m.categoryIds.Count() - 1
        if m.categoryIds[i] = categoryId then return i
    end for
    return -1
end function

sub onCategorySelected(event as Object)
    index = event.getData()
    if index < 0 or index >= m.categoryIds.Count() then return

    if index = 0 then
        openSearch()
        return
    end if

    selectCategory(m.categoryIds[index])
    focusGrid()
end sub

sub selectCategory(categoryId as String)
    m.currentCategoryId = categoryId

    catalog = m.libraries[m.section]
    if catalog = invalid then return

    for i = 0 to catalog.getChildCount() - 1
        category = catalog.getChild(i)
        if category.catId = categoryId then
            renderGrid(category)
            return
        end if
    end for
end sub

'-------------------------------------------------------------------- grid

sub renderGrid(category as Object)
    m.gridTitle.text = category.title + "  (" + category.itemCount.ToStr() + ")"
    m.gridEmpty.visible = false

    ' Marking favorites here rather than up front keeps it to the few hundred
    ' items actually on screen instead of the whole catalogue.
    applyFavorites(category)

    if m.section = "live" then
        m.posterGrid.visible = false
        m.liveGrid.content = category
        m.liveGrid.jumpToItem = 0
        m.liveGrid.visible = true
    else
        m.liveGrid.visible = false
        m.posterGrid.content = category
        m.posterGrid.jumpToItem = 0
        m.posterGrid.visible = true
    end if
end sub

sub applyFavorites(container as Object)
    if container = invalid then return
    for i = 0 to container.getChildCount() - 1
        child = container.getChild(i)
        child.isFavorite = m.favKeys.DoesExist(child.favKey)
    end for
end sub

sub refreshGridFavorites()
    grid = activeGrid()
    if grid <> invalid then applyFavorites(grid.content)
end sub

sub clearGrid(message as String)
    m.posterGrid.visible = false
    m.liveGrid.visible = false
    m.gridTitle.text = ""
    m.gridEmpty.text = message
    m.gridEmpty.visible = true
end sub

function activeGrid() as Object
    if m.section = "live" then return m.liveGrid
    return m.posterGrid
end function

sub onGridSelected(event as Object)
    grid = event.getRoSGNode()
    content = grid.content
    if content = invalid then return

    item = content.getChild(event.getData())
    if item = invalid then return

    if item.itemKind = "live" then
        playLive(item)
    else if item.itemKind = "series" then
        openSeries(item)
    else
        openDetail(item)
    end if
end sub

'--------------------------------------------------------------- favorites

sub renderFavorites()
    content = CreateObject("roSGNode", "ContentNode")
    for each entry in m.prefs.favorites
        if entry.item <> invalid then
            node = BuildItemNode(entry.item)
            node.isFavorite = true
            content.appendChild(node)
        end if
    end for

    m.liveGrid.visible = false

    if content.getChildCount() = 0 then
        m.posterGrid.visible = false
        m.sectionCount.text = ""
        m.gridTitle.text = ""
        m.gridEmpty.text = "No favorites yet. Press the * key on anything in Live TV, Movies or Series to add it here."
        m.gridEmpty.visible = true
        return
    end if

    m.gridEmpty.visible = false
    m.gridTitle.text = ""
    m.sectionCount.text = content.getChildCount().ToStr() + " saved"
    m.posterGrid.content = content
    m.posterGrid.jumpToItem = 0
    m.posterGrid.visible = true
end sub

'------------------------------------------------------------------ detail

sub openDetail(item as Object)
    m.detail.isFavorite = m.favKeys.DoesExist(item.favKey)
    m.detail.item = item
    m.detail.visible = true
    m.detail.callFunc("activate", invalid)
    setZone("detail")
end sub

sub onDetailPlay()
    item = m.detail.item
    if item = invalid then return

    hints = m.detail.playbackHints
    if hints = invalid then hints = {}

    startPlayback({
        kind: "movie",
        id: item.itemId,
        ext: item.ext,
        vcodec: AsText(hints.vcodec),
        acodec: AsText(hints.acodec),
        achannels: AsText(hints.achannels),
        title: item.title,
        subtitle: JoinParts([item.genre, item.rating], "  ·  "),
        isLive: false
    })
end sub

sub onDetailFavorite()
    toggleFavorite(m.detail.item)
end sub

'------------------------------------------------------------------ series

sub openSeries(item as Object)
    m.series.isFavorite = m.favKeys.DoesExist(item.favKey)
    m.series.item = item
    m.series.visible = true
    m.series.callFunc("activate", invalid)
    setZone("series")
end sub

sub onEpisodePlay()
    episode = m.series.selectedEpisode
    item = m.series.item
    if episode = invalid or item = invalid then return

    startPlayback({
        kind: "series",
        id: AsText(episode.id),
        ext: AsText(episode.ext),
        vcodec: AsText(episode.vcodec),
        acodec: AsText(episode.acodec),
        achannels: AsText(episode.achannels),
        title: item.title,
        subtitle: AsText(episode.label),
        isLive: false
    })
end sub

sub onSeriesFavorite()
    toggleFavorite(m.series.item)
end sub

'---------------------------------------------------------------- playback

sub playLive(item as Object)
    startPlayback({
        kind: "live",
        id: item.itemId,
        ext: "",
        vcodec: "",
        acodec: "",
        achannels: "",
        title: item.title,
        subtitle: "Live",
        isLive: true
    })
    ' What's on now is a nicety; it lands in the banner if it arrives.
    fetchNowPlaying(item.itemId)
end sub

sub startPlayback(spec as Object)
    m.pendingPlay = spec

    ' Live is HLS already — the Pi's preferredFormat is m3u8, so /api/play
    ' hands back a .m3u8 the Video node opens natively. Only VOD in a container
    ' Roku won't take has to be converted first.
    if spec.kind <> "live" and not IsNativeContainer(spec.ext) then
        showLoading("Converting for playback…", true)
        m.remuxTask = CreateObject("roSGNode", "RemuxTask")
        m.remuxTask.params = {
            kind: spec.kind,
            id: spec.id,
            ext: spec.ext,
            vcodec: spec.vcodec,
            acodec: spec.acodec,
            achannels: spec.achannels
        }
        m.remuxTask.observeField("progress", "onRemuxProgress")
        m.remuxTask.observeField("result", "onRemuxResult")
        m.remuxTask.control = "RUN"
        return
    end if

    showLoading("Starting…", false)
    m.playTask = CreateObject("roSGNode", "RequestTask")
    m.playTask.request = {
        url: ApiUrl("/api/play", { kind: spec.kind, id: spec.id, ext: spec.ext }),
        timeout: 30000
    }
    m.playTask.observeField("response", "onPlayResponse")
    m.playTask.control = "RUN"
end sub

sub onPlayResponse(event as Object)
    response = event.getData()
    if m.pendingPlay = invalid then return

    hideLoading()

    if not response.ok then
        showDialog("Can't play this", response.error)
        return
    end if

    payload = JsonObject(response)
    openPlayer(AbsoluteUrl(payload.url), StreamFormatFor(payload.format))
end sub

sub onRemuxProgress(event as Object)
    progress = event.getData()
    if progress = invalid then return

    m.loadingText.text = AsText(progress.message)

    target = AsNumber(progress.target)
    if target > 0 then
        fraction = AsNumber(progress.ready) / target
        if fraction > 1 then fraction = 1
        m.progressFill.width = 600 * fraction
    end if
end sub

sub onRemuxResult(event as Object)
    result = event.getData()
    hideLoading()

    if not result.ok then
        if result.error <> "" then showDialog("Couldn't convert this", result.error)
        ' An empty error means the user cancelled; nothing to say.
        return
    end if

    m.activeRemuxSession = AsText(result.session)
    openPlayer(result.url, "hls")
end sub

sub openPlayer(url as String, streamFormat as String)
    if m.pendingPlay = invalid or url = "" then return

    m.detail.visible = false
    m.series.visible = false
    m.player.visible = true
    m.player.request = {
        url: url,
        streamFormat: streamFormat,
        title: m.pendingPlay.title,
        subtitle: m.pendingPlay.subtitle,
        isLive: m.pendingPlay.isLive
    }
    m.player.callFunc("activate", invalid)
    setZone("player")
end sub

sub onPlayerClosed()
    m.player.callFunc("stopVideo", invalid)
    m.player.visible = false
    releaseRemux()

    ' Back out to wherever playback started from.
    if m.pendingPlay <> invalid and m.pendingPlay.kind = "series" then
        m.series.visible = true
        m.series.callFunc("activate", invalid)
        setZone("series")
    else if m.pendingPlay <> invalid and m.pendingPlay.kind = "movie" then
        m.detail.visible = true
        m.detail.callFunc("activate", invalid)
        setZone("detail")
    else
        focusGrid()
    end if
end sub

sub onPlaybackError()
    message = m.player.playbackError
    if message = "" then return

    m.player.callFunc("stopVideo", invalid)
    m.player.visible = false
    releaseRemux()
    showDialog("Playback stopped", message)
    focusGrid()
end sub

' ffmpeg keeps running on the Pi until it is told otherwise, and it is holding
' the provider's single connection while it does.
sub releaseRemux()
    if m.activeRemuxSession = "" then return
    m.activeRemuxSession = ""

    m.stopTask = CreateObject("roSGNode", "RequestTask")
    m.stopTask.request = { url: ApiUrl("/api/remux/stop", invalid), timeout: 10000 }
    m.stopTask.control = "RUN"
end sub

sub fetchNowPlaying(streamId as String)
    m.epgTask = CreateObject("roSGNode", "RequestTask")
    m.epgTask.request = {
        url: ApiUrl("/api/xtream", { action: "get_short_epg", stream_id: streamId, limit: "1" }),
        timeout: 15000
    }
    m.epgTask.tag = streamId
    m.epgTask.observeField("response", "onNowPlaying")
    m.epgTask.control = "RUN"
end sub

sub onNowPlaying(event as Object)
    response = event.getData()
    if not response.ok then return
    if not m.player.visible then return

    listings = JsonObject(response).epg_listings
    if listings = invalid or listings.Count() = 0 then return

    ' server.js has already base64-decoded these for us.
    title = AsText(listings[0].title)
    if title <> "" then m.player.subtitleText = "Now: " + title
end sub

'------------------------------------------------------------------ search

sub openSearch()
    m.textEntryMode = "search"
    m.textEntry.promptText = "Search categories"
    m.textEntry.hintText = "Filters the category list for " + m.sectionTitle.text + "."
    m.textEntry.text = m.catQuery
    m.textEntry.visible = true
    m.textEntry.callFunc("activate", invalid)
    setZone("textEntry")
end sub

sub onTextEntryChanged()
    if m.textEntryMode <> "search" then return
    m.catQuery = m.textEntry.text
    renderCategories()
end sub

sub onTextEntryClosed()
    m.textEntry.visible = false

    if m.textEntryMode = "server" then
        ConfigSetBaseUrl(m.textEntry.text)
        ' Everything cached came from the old address.
        m.libraries = {}
        m.libraryTotals = {}
        m.forceRefresh = false
        renderSettings()
        m.settingsNote.text = "Now pointing at " + ConfigBaseUrl() + ". Open a section to reload from it."
        loadPrefs()
        setZone("settings")
    else
        focusCategories()
    end if

    m.textEntryMode = ""
end sub

'---------------------------------------------------------------- settings

sub renderSettings()
    content = CreateObject("roSGNode", "ContentNode")

    row = CreateObject("roSGNode", "ContentNode")
    row.title = "Server address:  " + ConfigBaseUrl()
    content.appendChild(row)

    row = CreateObject("roSGNode", "ContentNode")
    state = "Off"
    if ConfigNativeMkv() then state = "On"
    row.title = "Play MKV without converting (experimental):  " + state
    content.appendChild(row)

    row = CreateObject("roSGNode", "ContentNode")
    row.title = "Reload the library from the provider"
    content.appendChild(row)

    m.settingsList.content = content
end sub

sub onSettingsSelected(event as Object)
    index = event.getData()

    if index = 0 then
        m.textEntryMode = "server"
        m.textEntry.promptText = "Server address"
        m.textEntry.hintText = "Host and port of the Pi, for example 192.168.1.20:8420"
        m.textEntry.text = ConfigBaseUrl()
        m.textEntry.visible = true
        m.textEntry.callFunc("activate", invalid)
        setZone("textEntry")
    else if index = 1 then
        ConfigSetNativeMkv(not ConfigNativeMkv())
        renderSettings()
        if ConfigNativeMkv() then
            m.settingsNote.text = "MKV files will be handed straight to the Video node. If one stalls or won't open, turn this back off — it will be converted through /api/remux instead."
        else
            m.settingsNote.text = "MKV files will be converted to HLS by the Pi before playing, the same way the web player does it."
        end if
    else if index = 2 then
        m.libraries = {}
        m.libraryTotals = {}
        m.forceRefresh = true
        m.settingsNote.text = "The next section you open will be pulled fresh from the provider. That takes a while — the cached copy would have been instant."
    end if
end sub

'-------------------------------------------------------------------- chrome

' withProgress marks the long, interruptible jobs — a conversion. A library
' fetch shows no bar and no cancel hint, because backing out of one would leave
' the section half-loaded behind the overlay.
sub showLoading(message as String, withProgress as Boolean)
    m.loadingText.text = message
    m.progressFill.width = 0
    m.progressTrack.visible = withProgress
    m.progressFill.visible = withProgress
    m.loadingHint.visible = withProgress
    m.loading.visible = true
end sub

sub hideLoading()
    m.loading.visible = false
end sub

sub cancelLoading()
    ' Only a conversion is cancellable; the hint is hidden for anything else.
    if not m.loadingHint.visible then return
    if m.remuxTask <> invalid then m.remuxTask.cancel = true
    m.pendingPlay = invalid
    hideLoading()
end sub

sub showDialog(title as String, message as String)
    dialog = CreateObject("roSGNode", "Dialog")
    dialog.title = title
    dialog.message = message
    dialog.buttons = ["OK"]
    dialog.observeField("buttonSelected", "onDialogClosed")
    m.top.dialog = dialog
end sub

sub onDialogClosed()
    m.top.dialog.close = true
end sub

sub closeOverlays()
    m.detail.visible = false
    m.series.visible = false
    m.textEntry.visible = false
    hideLoading()
end sub

'------------------------------------------------------------------- focus

sub setZone(zone as String)
    m.zone = zone

    if zone = "nav" then
        m.nav.setFocus(true)
    else if zone = "categories" then
        m.categories.setFocus(true)
    else if zone = "grid" then
        grid = activeGrid()
        if grid <> invalid then grid.setFocus(true)
    else if zone = "settings" then
        m.settingsList.setFocus(true)
    else if zone = "detail" then
        m.detail.setFocus(true)
    else if zone = "series" then
        m.series.setFocus(true)
    else if zone = "player" then
        m.player.setFocus(true)
    else if zone = "textEntry" then
        m.textEntry.setFocus(true)
    end if
end sub

sub focusNav()
    setZone("nav")
end sub

sub focusCategories()
    if m.section = "favorites" then
        setZone("nav")
        return
    end if
    setZone("categories")
end sub

sub focusGrid()
    grid = activeGrid()
    if grid = invalid or not grid.visible then
        focusCategories()
        return
    end if
    setZone("grid")
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false

    ' Overlays that own their own keys get first refusal before this runs; only
    ' what they ignored reaches here.
    if m.textEntry.visible then return false
    if m.player.visible then return false

    if m.loading.visible then
        if key = "back" then cancelLoading()
        ' Everything else is swallowed — half-navigating behind a conversion
        ' leaves the scene pointing at something that is no longer on screen.
        return true
    end if

    if m.detail.visible then
        if key = "back" then
            m.detail.visible = false
            focusGrid()
            return true
        end if
        if key = "options" then
            toggleFavorite(m.detail.item)
            return true
        end if
        return false
    end if

    if m.series.visible then
        if key = "back" then
            m.series.visible = false
            focusGrid()
            return true
        end if
        return false
    end if

    if m.section = "settings" then
        if key = "back" or key = "up" then
            focusNav()
            return true
        end if
        return false
    end if

    if key = "back" then
        if m.zone = "grid" then
            focusCategories()
            return true
        end if
        if m.zone = "categories" then
            focusNav()
            return true
        end if
        ' On the nav row, Back leaves the channel.
        return false
    end if

    if m.zone = "categories" then
        if key = "right" then
            focusGrid()
            return true
        end if
        if key = "up" then
            focusNav()
            return true
        end if
        if key = "options" then
            togglePinAtFocus()
            return true
        end if
    else if m.zone = "grid" then
        if key = "left" then
            focusCategories()
            return true
        end if
        if key = "up" then
            focusNav()
            return true
        end if
        if key = "options" then
            toggleFavoriteAtFocus()
            return true
        end if
    else if m.zone = "nav" then
        if key = "down" then
            focusCategories()
            return true
        end if
    end if

    return false
end function

sub togglePinAtFocus()
    index = m.categories.itemFocused
    if index <= 0 or index >= m.categoryIds.Count() then return
    togglePin(m.categoryIds[index])
end sub

sub toggleFavoriteAtFocus()
    grid = activeGrid()
    if grid = invalid or grid.content = invalid then return

    item = grid.content.getChild(grid.itemFocused)
    if item = invalid then return

    toggleFavorite(item)
end sub
