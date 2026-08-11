sub init()
    m.frame = m.top.findNode("frame")
    m.poster = m.top.findNode("poster")
    m.fallback = m.top.findNode("fallback")
    m.favBadge = m.top.findNode("favBadge")
    m.title = m.top.findNode("title")
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
    ' is the card colour and disappears into the grid.
    if focus > 0.5 then
        m.frame.color = theme.brand
        m.title.color = theme.text
    else
        m.frame.color = theme.bgCard
        m.title.color = theme.muted
    end if
end sub
