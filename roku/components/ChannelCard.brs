sub init()
    m.frame = m.top.findNode("frame")
    m.logo = m.top.findNode("logo")
    m.name = m.top.findNode("name")
    m.favMark = m.top.findNode("favMark")
end sub

sub onContentChanged()
    ' Grid cells are recycled, so the previous row's node has to be let go of
    ' or its heart keeps arriving here after it has scrolled away.
    if m.watched <> invalid then m.watched.unobserveField("isFavorite")

    content = m.top.itemContent
    if content = invalid then return

    m.watched = content
    content.observeField("isFavorite", "onFavoriteChanged")

    m.name.text = content.title
    m.logo.uri = ItemPoster(content)
    m.favMark.visible = content.isFavorite
end sub

sub onFavoriteChanged()
    content = m.top.itemContent
    if content = invalid then return
    m.favMark.visible = content.isFavorite
end sub

sub onFocusChanged()
    focus = m.top.focusPercent
    theme = Theme()

    if focus > 0.5 then
        m.frame.color = theme.brand
        m.name.color = theme.text
    else
        m.frame.color = theme.bgCard
        m.name.color = theme.muted
    end if
end sub
