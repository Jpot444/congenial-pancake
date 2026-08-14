' The whole browse experience: tabs, categories, grids, and the handoff into
' detail, series and playback. Anything that touches the network goes out to a
' Task node; this file only ever reacts to what comes back.

sub init()
    m.nav = m.top.findNode("nav")
    m.browse = m.top.findNode("browse")
    m.sectionTitle = m.top.findNode("sectionTitle")
    m.sectionCount = m.top.findNode("sectionCount")
    m.categories = m.top.findNode("categories")
    m.categoriesHead = m.top.findNode("categoriesHead")
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
    m.progressTrack = m.top.findNode("progressTrack")
    m.progressFill = m.top.findNode("progressFill")

    m.tabs = ["live", "movies", "series", "favorites", "settings"]
    m.tabLabels = ["Live TV", "Movies", "Series", "Favorites", "Settings"]
    m.section = "live"

    ' section -> ContentNode of its categories. Only the category lists are
    ' cached; a few hundred rows each is nothing, where the streams inside them
    ' are tens of thousands and are fetched one category at a time.
    m.categoryLists = {}
    m.forceRefresh = false
    m.started = false

    m.catQuery = ""
    m.titleQuery = ""
    m.categoryIds = []
    m.currentCategoryId = ""

    m.prefs = { pinnedCategories: [], favorites: [], filters: {}, filtersEnabled: true }
    m.favKeys = {}

    ' Titles this television has failed to play, learned by trying. Local to
    ' the device — see the note in Config.brs.
    m.unplayable = ConfigUnplayable()

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
    m.player.observeField("startedCount", "onPlaybackStarted")
    m.textEntry.observeField("text", "onTextEntryChanged")
    m.textEntry.observeField("closeCount", "onTextEntryClosed")

    ' A load that never finishes used to leave the overlay up forever, and the
    ' overlay swallows every key — so the remote went dead and the Roku
    ' eventually exited the channel on its own. Give it a deadline.
    m.loadWatchdog = CreateObject("roSGNode", "Timer")
    m.loadWatchdog.duration = 150
    m.loadWatchdog.repeat = false
    m.loadWatchdog.observeField("fire", "onLoadTimedOut")
    m.top.appendChild(m.loadWatchdog)

    renderSettings()

    ' The section load waits on prefs. Categories are filtered here now rather
    ' than by the server, using the regex /api/prefs carries, so loading before
    ' it arrives would show the unfiltered list and then have to redo it.
    showLoading("Starting…", false)
    loadPrefs()

    ' Somewhere in the scene has to hold focus from the first frame, or the
    ' remote does nothing until the catalogue lands.
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
    if response.ok then
        data = JsonObject(response)
        if data.pinnedCategories <> invalid then m.prefs.pinnedCategories = data.pinnedCategories
        if data.favorites <> invalid then m.prefs.favorites = data.favorites
        if data.filters <> invalid then m.prefs.filters = data.filters
        if data.filtersEnabled <> invalid then m.prefs.filtersEnabled = (data.filtersEnabled = true)
    else
        ' Not fatal: browsing works without pins, favorites or the filter — the
        ' unfiltered category list is just longer. Say so in the hint line
        ' rather than blocking with a dialog.
        m.browseHint.text = "Couldn't load pins and favorites — " + response.error
    end if

    rebuildFavoriteIndex()

    ' The first reply is what releases the opening section.
    if not m.started then
        m.started = true
        hideLoading()
        showTab("live")
        return
    end if

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

sub saveFilterSetting()
    m.filterSaveTask = CreateObject("roSGNode", "RequestTask")
    m.filterSaveTask.request = {
        url: ApiUrl("/api/prefs", invalid),
        method: "PUT",
        body: FormatJson({ filtersEnabled: m.prefs.filtersEnabled }),
        timeout: 20000
    }
    m.filterSaveTask.observeField("response", "onPrefsSaved")
    m.filterSaveTask.control = "RUN"
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

    key = ItemFavKey(item)
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
    if ItemFavKey(m.detail.item) = key then m.detail.isFavorite = nowFavorite
    if ItemFavKey(m.series.item) = key then m.series.isFavorite = nowFavorite

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
        setSectionLabel("Favorites")
        m.categories.visible = false
        m.categoriesHead.visible = false
        m.categoryEmpty.visible = false
        ' No category pane here, so the grid takes the full width.
        m.gridTitle.translation = [60, 148]
        m.posterGrid.translation = [60, 214]
        m.gridEmpty.translation = [60, 222]
        m.posterGrid.numColumns = 7
        m.browseHint.text = "OK to open  ·  * to remove from favorites"
        renderFavorites()
        focusGrid()
        return
    end if

    m.categories.visible = true
    m.categoriesHead.visible = true
    m.gridTitle.translation = [640, 148]
    m.posterGrid.translation = [640, 214]
    m.gridEmpty.translation = [640, 222]
    m.posterGrid.numColumns = 5

    if section = "live" then
        setSectionLabel("Live TV")
    else if section = "movies" then
        setSectionLabel("Movies")
    else
        setSectionLabel("Series")
    end if
    m.browseHint.text = "OK to open  ·  * to pin a category or favorite an item  ·  Back to step out"

    catalog = m.categoryLists[section]
    if catalog <> invalid and not m.forceRefresh then
        renderCategories()
        setZone("categories")
        return
    end if

    loadCategories(section)
end sub

' The heading is uppercased to match the text-transform the web player puts on
' its display face, but the same name also turns up mid-sentence in the loading
' overlay, the search prompt and the dialogs — where caps would read as
' shouting. The sentence-case form is kept alongside for those.
sub setSectionLabel(label as String)
    m.sectionLabel = label
    m.sectionTitle.text = UCase(label)
end sub

'----------------------------------------------------------------- catalogue

sub loadCategories(section as String)
    m.sectionCount.text = ""
    m.categories.content = invalid
    m.posterGrid.content = invalid
    m.liveGrid.content = invalid
    m.posterGrid.visible = false
    m.liveGrid.visible = false
    m.gridTitle.text = ""
    m.gridEmpty.visible = false

    showLoading("Loading " + m.sectionLabel + "…", false)
    m.loadWatchdog.control = "start"

    m.categoriesTask = CreateObject("roSGNode", "CategoriesTask")
    m.categoriesTask.section = section
    m.categoriesTask.pattern = filterPattern(section)
    m.categoriesTask.observeField("done", "onCategoriesDone")
    m.categoriesTask.control = "RUN"
end sub

' Going straight to /api/xtream skips the filtering /api/library would have
' applied, so the same regex from /api/prefs is applied here instead. An empty
' pattern keeps everything, which is also what happens with filters switched
' off on the server.
function filterPattern(section as String) as String
    if not m.prefs.filtersEnabled then return ""
    if m.prefs.filters = invalid then return ""
    return AsText(m.prefs.filters[section])
end function

sub onLoadTimedOut()
    if not m.loading.visible then return

    hideLoading()
    gap = Chr(10) + Chr(10)
    detail = "The Pi hasn't answered in over two minutes." + gap
    detail = detail + "Trying: " + ConfigBaseUrl() + gap
    detail = detail + "It may still be building the catalogue from the provider — if so, opening the section again shortly will find it cached and instant."
    showDialog("Still waiting on " + m.sectionLabel, detail)
    setZone("nav")
end sub

sub onCategoriesDone(event as Object)
    task = event.getRoSGNode()
    if not event.getData() then return

    m.forceRefresh = false

    ' The user may have moved on while this was in flight. Nothing below should
    ' put a dialog over, or a spinner under, a section they already left — and
    ' the watchdog now belongs to whatever load replaced this one, so stopping
    ' it here would leave that one with no deadline.
    if task.section <> m.section then
        if task.errorMessage = "" then m.categoryLists[task.section] = task.catalog
        return
    end if

    m.loadWatchdog.control = "stop"
    hideLoading()

    if task.errorMessage <> "" then
        m.gridEmpty.text = task.errorMessage
        m.gridEmpty.visible = true
        gap = Chr(10) + Chr(10)
        detail = task.errorMessage + gap + "Trying: " + ConfigBaseUrl()
        detail = detail + gap + "If that address is wrong, change it under Settings."
        showDialog("Can't load " + m.sectionLabel, detail)
        setZone("nav")
        return
    end if

    m.categoryLists[task.section] = task.catalog

    renderCategories()
    setZone("categories")
end sub

'-------------------------------------------------------------- categories

sub renderCategories()
    if m.section = "favorites" or m.section = "settings" then return

    catalog = m.categoryLists[m.section]
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

    ' Both searches live in the list itself. A dedicated remote key would be
    ' faster but nothing on screen would ever tell you it existed.
    searchLabel = "Filter categories"
    if m.catQuery <> "" then searchLabel = "Filter: " + m.catQuery
    content.appendChild(BuildCategoryProxy(searchLabel, "", 0, false, true))
    m.categoryIds.Push("")

    titleLabel = "Search all titles"
    if m.titleQuery <> "" then titleLabel = "Search: " + m.titleQuery
    content.appendChild(BuildCategoryProxy(titleLabel, "", 0, false, true))
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

    shown = pinned.Count() + rest.Count()
    m.sectionCount.text = shown.ToStr() + " categories"

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
    if target < 2 then target = 2
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

    if index = 1 then
        openTitleSearch()
        return
    end if

    selectCategory(m.categoryIds[index])
    focusGrid()
end sub

' Fetched per category rather than sliced out of a whole-section download.
' Averaged over this provider's Live section that is about 63 rows, not 57,050.
sub selectCategory(categoryId as String)
    m.currentCategoryId = categoryId
    if categoryId = "" then return

    m.posterGrid.visible = false
    m.liveGrid.visible = false
    m.gridTitle.text = categoryTitle(categoryId)
    m.gridEmpty.text = "Loading…"
    m.gridEmpty.visible = true

    m.itemsTask = CreateObject("roSGNode", "CategoryItemsTask")
    m.itemsTask.section = m.section
    m.itemsTask.categoryId = categoryId
    m.itemsTask.observeField("done", "onCategoryItems")
    m.itemsTask.control = "RUN"
end sub

sub onCategoryItems(event as Object)
    task = event.getRoSGNode()
    if not event.getData() then return

    ' Categories can be stepped through faster than the Pi answers.
    if task.section <> m.section or task.categoryId <> m.currentCategoryId then return

    if task.errorMessage <> "" then
        clearGrid("Couldn't load this category: " + task.errorMessage)
        return
    end if

    renderGrid(task.items, categoryTitle(task.categoryId))
end sub

function UnplayableCount() as Integer
    total = 0
    for each key in m.unplayable
        total = total + 1
    end for
    return total
end function

function categoryTitle(categoryId as String) as String
    catalog = m.categoryLists[m.section]
    if catalog = invalid then return ""
    for i = 0 to catalog.getChildCount() - 1
        category = catalog.getChild(i)
        if category.catId = categoryId then return category.title
    end for
    return ""
end function

'-------------------------------------------------------------------- grid

sub renderGrid(content as Object, title as String)
    if content = invalid then return

    if ConfigHideUnplayable() then dropUnplayable(content)

    count = content.getChildCount()
    m.gridTitle.text = title + "  (" + count.ToStr() + ")"

    if count = 0 then
        m.posterGrid.visible = false
        m.liveGrid.visible = false
        m.gridEmpty.text = "Nothing in this category."
        m.gridEmpty.visible = true
        return
    end if

    m.gridEmpty.visible = false
    applyFavorites(content)

    if m.section = "live" then
        m.posterGrid.visible = false
        m.liveGrid.content = content
        m.liveGrid.jumpToItem = 0
        m.liveGrid.visible = true
    else
        m.liveGrid.visible = false
        m.posterGrid.content = content
        m.posterGrid.jumpToItem = 0
        m.posterGrid.visible = true
    end if
end sub

sub applyFavorites(container as Object)
    if container = invalid then return
    for i = 0 to container.getChildCount() - 1
        child = container.getChild(i)
        key = ItemFavKey(child)
        child.isFavorite = m.favKeys.DoesExist(key)
        child.unplayable = m.unplayable.DoesExist(key)
    end for
end sub

' Drops what this box cannot play out of a freshly fetched category. Safe to
' mutate: the node came straight from the task and nothing else holds it.
sub dropUnplayable(container as Object)
    if container = invalid then return
    for i = container.getChildCount() - 1 to 0 step -1
        child = container.getChild(i)
        if m.unplayable.DoesExist(ItemFavKey(child)) then container.removeChildIndex(i)
    end for
end sub

' Remembered only after every fallback has been tried, so a first-attempt
' hiccup does not condemn a channel.
sub rememberUnplayable(spec as Object)
    if spec = invalid then return

    key = FavKey(spec.kind, spec.id)
    if key = "" or m.unplayable.DoesExist(key) then return

    m.unplayable[key] = true
    ConfigSaveUnplayable(m.unplayable)
    print "[unplayable] remembered " + key
    refreshGridFavorites()
end sub

' And forgotten the moment it plays. A stream that was merely down, or a title
' the provider has since fixed, should not stay struck out forever.
sub onPlaybackStarted()
    if m.pendingPlay = invalid then return

    key = FavKey(m.pendingPlay.kind, m.pendingPlay.id)
    if key = "" or not m.unplayable.DoesExist(key) then return

    m.unplayable.Delete(key)
    ConfigSaveUnplayable(m.unplayable)
    print "[unplayable] cleared " + key
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
    m.detail.isFavorite = m.favKeys.DoesExist(ItemFavKey(item))
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
        isLive: false,
        attempt: 0,
        forceRemux: false,
        forceTranscode: false
    })
end sub

sub onDetailFavorite()
    toggleFavorite(m.detail.item)
end sub

'------------------------------------------------------------------ series

sub openSeries(item as Object)
    m.series.isFavorite = m.favKeys.DoesExist(ItemFavKey(item))
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
        isLive: false,
        attempt: 0,
        forceRemux: false,
        forceTranscode: false
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
        isLive: true,
        attempt: 0,
        forceRemux: false,
        forceTranscode: false
    })
    ' What's on now is a nicety; it lands in the banner if it arrives.
    fetchNowPlaying(item.itemId)
end sub

sub startPlayback(spec as Object)
    m.pendingPlay = spec

    ' Live is HLS already — the Pi's preferredFormat is m3u8, so /api/play
    ' hands back a .m3u8 the Video node opens natively. Only VOD in a container
    ' Roku won't take has to be converted first.
    if spec.forceRemux or spec.forceTranscode or (spec.kind <> "live" and not IsNativeContainer(spec.ext)) then
        ' Re-encoding is slow enough that calling it "converting" would look
        ' like a hang. Say which one is happening.
        if spec.forceTranscode then
            showLoading("Re-encoding for this TV — this takes a while…", spec.kind <> "live")
        else if spec.kind = "live" then
            ' No progress bar for live: there is no buffer being banked to
            ' report, only the wait for ffmpeg's first couple of segments.
            showLoading("Converting this channel…", false)
        else
            showLoading("Converting for playback…", true)
        end if

        m.remuxTask = CreateObject("roSGNode", "RemuxTask")
        if spec.kind = "live" then
            ' No codec hints to offer — the section listing does not carry
            ' them for live — so the server probes and picks the packaging.
            params = { kind: "live", id: spec.id }
            if spec.forceTranscode then params.transcode = "1"
            m.remuxTask.params = params
            ' A copied live stream is ready as fast as the provider sends it,
            ' so there is nothing to wait for. An encoded one is produced at
            ' about the speed it plays, and starting at the live edge with no
            ' cushion underruns immediately.
            m.remuxTask.skipPrebuffer = not spec.forceTranscode
        else
            params = {
                kind: spec.kind,
                id: spec.id,
                ext: spec.ext,
                vcodec: spec.vcodec,
                acodec: spec.acodec,
                achannels: spec.achannels
            }
            if spec.forceTranscode then params.transcode = "1"
            m.remuxTask.params = params
        end if
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
    print "[play] " + m.pendingPlay.kind + " id=" + m.pendingPlay.id + " ext=" + m.pendingPlay.ext + " as " + streamFormat + " attempt=" + m.pendingPlay.attempt.ToStr() + " url=" + url

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

    if retryPlayback(message) then return

    ' Every route has been tried, so this one is genuinely beyond this box.
    rememberUnplayable(m.pendingPlay)

    gap = Chr(10) + Chr(10)
    detail = message + gap
    detail = detail + "Tried playing it directly, repackaged, and re-encoded on the Pi." + gap
    detail = detail + "Marked as unplayable on this Roku. It stays marked until it plays."
    showDialog("Playback stopped", detail)
    focusGrid()
end sub

' Roku's decoders and its HLS parser are both stricter than a browser's, so a
' stream the web player opens can still fail here. Rather than stopping at the
' first refusal, fall back once to the other way of getting the same title.
' Three rungs, cheapest first: play the provider's stream as it comes, then
' repackage it, then re-encode it. Each one costs more than the last, and the
' last one costs the Pi real work, so nothing skips ahead — a title only
' reaches the encoder once the two free answers have both been wrong.
function retryPlayback(message as String) as Boolean
    spec = m.pendingPlay
    if spec = invalid then return false
    if spec.attempt >= 2 then return false

    retry = {}
    for each field in spec
        retry[field] = spec[field]
    end for
    retry.attempt = spec.attempt + 1

    ' Rung two. Both kinds fall back the same way here. Retrying live as plain
    ' TS was tried and changed nothing, which is the clue: HEVC inside MPEG-TS
    ' is something Roku will not demux in either wrapper, and it reports that
    ' as corrupt data rather than as an unsupported codec. Repackaging into
    ' fragmented MP4 is what fixes it, and costs no re-encoding.
    if not spec.forceRemux then
        retry.forceRemux = true
        print "[play] direct play failed, retrying through /api/remux — " + message
        startPlayback(retry)
        return true
    end if

    ' Rung three. Repackaging moved the same video into a different container
    ' and the television still refused it, so the container was never the
    ' problem — the codec is. MPEG-2, Xvid, VC-1 and 10-bit H.264 all reach
    ' here: perfectly good files that this box has no decoder for. Only a real
    ' re-encode helps, and only the server can do it.
    if spec.forceTranscode then return false
    retry.forceTranscode = true
    print "[play] remuxed stream refused too, retrying re-encoded — " + message
    startPlayback(retry)
    return true
end function

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

sub openTitleSearch()
    m.textEntryMode = "titles"
    m.textEntry.promptText = "Search " + m.sectionLabel
    m.textEntry.hintText = "Searches every title in this section, not just the open category."
    m.textEntry.text = m.titleQuery
    m.textEntry.visible = true
    m.textEntry.callFunc("activate", invalid)
    setZone("textEntry")
end sub

' Run when the keyboard closes rather than on each keystroke: every search is a
' round trip, and a request per letter would hammer the Pi for results nobody
' has read yet.
sub runTitleSearch()
    if Len(m.titleQuery) < 2 then
        renderCategories()
        return
    end if

    m.posterGrid.visible = false
    m.liveGrid.visible = false
    m.gridTitle.text = "Searching for “" + m.titleQuery + "”…"
    m.gridEmpty.text = "The first search of a section can take a while — the Pi builds its catalogue once, then answers from memory."
    m.gridEmpty.visible = true

    m.searchTask = CreateObject("roSGNode", "SearchTask")
    m.searchTask.section = m.section
    m.searchTask.query = m.titleQuery
    m.searchTask.observeField("done", "onSearchResults")
    m.searchTask.control = "RUN"
end sub

sub onSearchResults(event as Object)
    task = event.getRoSGNode()
    if not event.getData() then return
    if task.section <> m.section or task.query <> m.titleQuery then return

    if task.errorMessage <> "" then
        clearGrid("Couldn't search: " + task.errorMessage)
        return
    end if

    shown = task.items.getChildCount()
    label = "“" + m.titleQuery + "”"
    if task.total > shown then
        label = label + "  —  first " + shown.ToStr() + " of " + task.total.ToStr()
    end if

    ' Cleared so stepping back into a category reloads it rather than assuming
    ' the grid already holds it.
    m.currentCategoryId = ""
    renderGrid(task.items, label)
end sub

sub openSearch()
    m.textEntryMode = "search"
    m.textEntry.promptText = "Search categories"
    m.textEntry.hintText = "Filters the category list for " + m.sectionLabel + "."
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
        ' Only write when the text actually changed. Opening this screen and
        ' backing straight out used to save whatever was on display, which
        ' pinned the then-current default into the registry — where it went on
        ' overriding every later build's default.
        if ConfigNormalizeBase(m.textEntry.text) <> ConfigBaseUrl() then
            ConfigSetBaseUrl(m.textEntry.text)
            applyServerChange("Now pointing at " + ConfigBaseUrl() + ". Open a section to reload from it.")
        end if
        setZone("settings")
    else if m.textEntryMode = "titles" then
        m.titleQuery = m.textEntry.text
        renderCategories()
        runTitleSearch()
        focusCategories()
    else
        focusCategories()
    end if

    m.textEntryMode = ""
end sub

'---------------------------------------------------------------- settings

' Everything cached, including the prefs, came from the old address.
sub applyServerChange(note as String)
    m.categoryLists = {}
    m.forceRefresh = false
    m.prefs = { pinnedCategories: [], favorites: [] }
    rebuildFavoriteIndex()
    renderSettings()
    m.settingsNote.text = note
    loadPrefs()
end sub

' Row order is the contract between these two — renderSettings writes them
' and onSettingsSelected reads the index back, so they change together.
sub renderSettings()
    content = CreateObject("roSGNode", "ContentNode")

    content.appendChild(SettingsRow("Server address:  " + ConfigBaseUrl()))
    content.appendChild(SettingsRow("Reset server address to this build's default  (" + ConfigDefaultBase() + ")"))
    content.appendChild(SettingsRow("Hide non-English categories:  " + OnOff(m.prefs.filtersEnabled)))
    content.appendChild(SettingsRow("Hide titles that failed to play:  " + OnOff(ConfigHideUnplayable())))
    content.appendChild(SettingsRow("Forget the " + UnplayableCount().ToStr() + " titles marked unplayable"))
    content.appendChild(SettingsRow("Play MKV without converting (experimental):  " + OnOff(ConfigNativeMkv())))
    content.appendChild(SettingsRow("Reload the category lists"))

    m.settingsList.content = content
end sub

function SettingsRow(title as String) as Object
    row = CreateObject("roSGNode", "ContentNode")
    row.title = title
    return row
end function

function OnOff(enabled as Boolean) as String
    if enabled then return "On"
    return "Off"
end function

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
        ConfigClearBaseUrl()
        applyServerChange("Back to " + ConfigBaseUrl() + ". Open a section to load from it.")

    else if index = 2 then
        ' This one is shared with the web player rather than local to the TV —
        ' it is the same prefs.filtersEnabled the web player's own toggle
        ' writes, and the same regexes decide it in both places.
        m.prefs.filtersEnabled = not m.prefs.filtersEnabled
        saveFilterSetting()
        m.categoryLists = {}
        renderSettings()
        if m.prefs.filtersEnabled then
            m.settingsNote.text = "Categories are filtered to the English ones, using the patterns in prefs.json. This also applies in the web player — it is the same setting."
        else
            m.settingsNote.text = "Every category the provider offers is listed, all 911 of Live TV among them. This also applies in the web player."
        end if

    else if index = 3 then
        ConfigSetHideUnplayable(not ConfigHideUnplayable())
        renderSettings()
        if ConfigHideUnplayable() then
            m.settingsNote.text = "Titles this Roku has failed to play are left out of the grids entirely. They come back if you turn this off."
        else
            m.settingsNote.text = "Titles this Roku has failed to play stay in the grids, dimmed and labelled, so you can still try them."
        end if

    else if index = 4 then
        m.unplayable = {}
        ConfigSaveUnplayable(m.unplayable)
        renderSettings()
        refreshGridFavorites()
        m.settingsNote.text = "Cleared. Everything is worth trying again — anything that still fails will re-mark itself."

    else if index = 5 then
        ConfigSetNativeMkv(not ConfigNativeMkv())
        renderSettings()
        if ConfigNativeMkv() then
            m.settingsNote.text = "MKV files will be handed straight to the Video node. If one stalls or won't open, turn this back off — it will be converted through /api/remux instead."
        else
            m.settingsNote.text = "MKV files will be converted to HLS by the Pi before playing, the same way the web player does it."
        end if

    else if index = 6 then
        m.categoryLists = {}
        m.forceRefresh = true
        m.settingsNote.text = "Category lists will be re-read the next time you open a section."
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
    m.loading.visible = true
end sub

sub hideLoading()
    m.loading.visible = false
end sub

' Back always gets you out of the overlay, whatever it is waiting on. A library
' fetch left running is harmless — it fills the cache and onLibraryDone drops
' the result if you have moved on — and being unable to leave is much worse
' than an abandoned request.
sub cancelLoading()
    if m.remuxTask <> invalid then m.remuxTask.cancel = true
    m.pendingPlay = invalid
    m.loadWatchdog.control = "stop"
    hideLoading()
    setZone("nav")
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
    ' The two standing rows at the top are not categories and cannot be pinned.
    if index <= 1 or index >= m.categoryIds.Count() then return
    togglePin(m.categoryIds[index])
end sub

sub toggleFavoriteAtFocus()
    grid = activeGrid()
    if grid = invalid or grid.content = invalid then return

    item = grid.content.getChild(grid.itemFocused)
    if item = invalid then return

    toggleFavorite(item)
end sub
