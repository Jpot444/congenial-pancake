sub init()
    m.prompt = m.top.findNode("prompt")
    m.hint = m.top.findNode("hint")
    m.keyboard = m.top.findNode("keyboard")
    m.keyboard.observeField("text", "onKeyboardText")
end sub

' The two halves of the mirror. Each one checks before it writes, so the pair
' settles after a single hop instead of bouncing the value between them.
sub onTextSet()
    if m.keyboard.text <> m.top.text then m.keyboard.text = m.top.text
end sub

sub onKeyboardText()
    if m.top.text <> m.keyboard.text then m.top.text = m.keyboard.text
end sub

sub onPromptChanged()
    m.prompt.text = m.top.promptText
end sub

sub onHintChanged()
    m.hint.text = m.top.hintText
end sub

' The scene calls this instead of setting focus on the group, so the caret
' lands in the keyboard rather than nowhere. Called through callFunc, which
' always passes an argument.
sub activate(args as Dynamic)
    m.keyboard.setFocus(true)
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false

    if key = "back" then
        m.top.closeCount = m.top.closeCount + 1
        return true
    end if

    return false
end function
