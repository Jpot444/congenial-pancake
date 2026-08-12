sub init()
    m.background = m.top.findNode("background")
    m.marker = m.top.findNode("marker")
    m.pin = m.top.findNode("pin")
    m.name = m.top.findNode("name")
    m.count = m.top.findNode("count")
end sub

sub onContentChanged()
    content = m.top.itemContent
    if content = invalid then return

    m.name.text = content.title

    if content.itemCount > 0 then
        m.count.text = content.itemCount.ToStr()
    else
        m.count.text = ""
    end if

    m.pin.visible = content.pinned
end sub

sub onFocusChanged()
    focus = m.top.focusPercent
    m.background.opacity = focus
    m.marker.opacity = focus

    theme = Theme()
    if focus > 0.5 then
        m.name.color = theme.text
    else
        m.name.color = theme.muted
    end if
end sub
