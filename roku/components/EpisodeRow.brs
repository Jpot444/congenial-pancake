sub init()
    m.background = m.top.findNode("background")
    m.marker = m.top.findNode("marker")
    m.number = m.top.findNode("number")
    m.name = m.top.findNode("name")
    m.runtime = m.top.findNode("runtime")
end sub

sub onContentChanged()
    content = m.top.itemContent
    if content = invalid then return

    m.number.text = content.epNumber
    m.name.text = content.title
    m.runtime.text = content.runtime
end sub

sub onFocusChanged()
    focus = m.top.focusPercent
    theme = Theme()

    m.background.opacity = focus
    m.marker.opacity = focus

    if focus > 0.5 then
        m.name.color = theme.text
        m.number.color = theme.brand
    else
        m.name.color = theme.muted
        m.number.color = theme.mutedDim
    end if
end sub
