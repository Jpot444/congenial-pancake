sub init()
    m.frame = m.top.findNode("frame")
    m.poster = m.top.findNode("poster")
    m.fallback = m.top.findNode("fallback")
    m.favBadge = m.top.findNode("favBadge")
    m.blockedBar = m.top.findNode("blockedBar")
    m.title = m.top.findNode("title")
    m.ratingRow = m.top.findNode("ratingRow")
    m.ratingText = m.top.findNode("ratingText")
end sub

sub onContentChanged()
    ' Grid cells are recycled, so the previous row's node has to be let go of
    ' or its heart keeps arriving here after it has scrolled away.
    if m.watched <> invalid then m.watched.unobserveField("isFavorite")

    content = m.top.itemContent
    if content = invalid then return

    m.watched = content
    content.observeField("isFavorite", "onFavoriteChanged")

    m.title.text = content.title

    ' Providers leave rating blank far more often than they fill it, and an
    ' orphan star under half the grid looks like a rendering fault.
    rating = AsText(content.rating)
    m.ratingText.text = rating
    m.ratingRow.visible = (rating <> "")

    poster = ItemPoster(content)
    if poster <> "" then
        m.poster.uri = poster
        m.fallback.visible = false
    else
        m.poster.uri = ""
        m.fallback.text = content.title
        m.fallback.visible = true
    end if

    m.favBadge.visible = content.isFavorite

    ' Dimmed as well as labelled: the point is to be able to skip past these
    ' without reading anything.
    m.blockedBar.visible = content.unplayable
    if content.unplayable then
        m.poster.opacity = 0.3
    else
        m.poster.opacity = 1.0
    end if
end sub

sub onFavoriteChanged()
    content = m.top.itemContent
    if content = invalid then return
    m.favBadge.visible = content.isFavorite
end sub

sub onFocusChanged()
    focus = m.top.focusPercent
    theme = Theme()

    ' The frame only reads as a highlight once it turns brand red; unfocused it
    ' is the hairline border .card-art carries and disappears into the grid.
    ' The title stays at --text throughout, as it does on the web.
    if focus > 0.5 then
        m.frame.color = theme.brand
    else
        m.frame.color = theme.lineSoft
    end if
end sub
