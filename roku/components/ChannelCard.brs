' The web player pulses .badge .dot on a CSS keyframe. It is left static here:
' a grid holds a few dozen live cells and recycles them as it scrolls, so that
' would be a few dozen animations starting and stopping on every row change for
' a detail nobody reads from a sofa.

sub init()
    m.frame = m.top.findNode("frame")
    m.logo = m.top.findNode("logo")
    m.name = m.top.findNode("name")
    m.favMark = m.top.findNode("favMark")
    m.blockedBar = m.top.findNode("blockedBar")
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

    m.blockedBar.visible = content.unplayable
    if content.unplayable then
        m.logo.opacity = 0.3
    else
        m.logo.opacity = 1.0
    end if
end sub

sub onFavoriteChanged()
    content = m.top.itemContent
    if content = invalid then return
    m.favMark.visible = content.isFavorite
end sub

' .card-title sits at full --text either way in the web player; the tile itself
' is what answers the pointer. Same split here, with the border going brand red
' rather than merely lighter — a mouse has a cursor to say where it is and a
' remote does not.
sub onFocusChanged()
    focus = m.top.focusPercent
    theme = Theme()

    if focus > 0.5 then
        m.frame.color = theme.brand
    else
        m.frame.color = theme.lineSoft
    end if
end sub
