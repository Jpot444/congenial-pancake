sub init()
    m.video = m.top.findNode("video")
    m.banner = m.top.findNode("banner")
    m.title = m.top.findNode("title")
    m.subtitle = m.top.findNode("subtitle")

    m.video.observeField("state", "onStateChanged")

    m.bannerTimer = CreateObject("roSGNode", "Timer")
    m.bannerTimer.duration = 5
    m.bannerTimer.repeat = false
    m.bannerTimer.observeField("fire", "hideBanner")
    m.top.appendChild(m.bannerTimer)
end sub

' activate and stopVideo are called through callFunc, which always passes an argument.
sub activate(args as Dynamic)
    m.video.setFocus(true)
end sub

sub onRequestChanged()
    request = m.top.request
    if request = invalid or AsText(request.url) = "" then return

    m.top.playbackError = ""

    content = CreateObject("roSGNode", "ContentNode")
    content.url = request.url
    content.streamFormat = AsText(request.streamFormat)
    content.title = AsText(request.title)

    m.title.text = AsText(request.title)
    m.top.subtitleText = AsText(request.subtitle)
    showBanner()

    m.video.content = content
    m.video.control = "play"
    m.video.setFocus(true)
end sub

sub onSubtitleChanged()
    m.subtitle.text = m.top.subtitleText
end sub

sub stopVideo(args as Dynamic)
    stopPlayback()
end sub

sub stopPlayback()
    m.video.control = "stop"
    m.video.content = invalid
end sub

sub showBanner()
    m.banner.visible = true
    m.bannerTimer.control = "start"
end sub

sub hideBanner()
    m.banner.visible = false
end sub

sub onStateChanged()
    state = m.video.state

    if state = "error" then
        detail = AsText(m.video.errorMsg)
        if detail = "" then detail = "the stream would not open"
        ' The numeric code is what Roku's docs are indexed by, and it survives
        ' into the console even when errorMsg is vague.
        print "[player] error " + AsText(m.video.errorCode) + ": " + detail
        ' The code goes on screen as well as to the console — Roku's error
        ' codes are documented by number, and it saves needing a laptop
        ' attached to find out what the device objected to.
        m.top.playbackError = "Playback failed (error " + AsText(m.video.errorCode) + ") — " + detail
        return
    end if

    if state = "finished" then
        m.top.closed = m.top.closed + 1
        return
    end if

    if state = "playing" then hideBannerSoon()
end sub

sub hideBannerSoon()
    ' Restart rather than leave the banner up: buffering can flip the state
    ' back and forth, and each pass should give the same short look at it.
    m.bannerTimer.control = "stop"
    m.bannerTimer.control = "start"
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false

    if key = "back" then
        stopPlayback()
        m.top.closed = m.top.closed + 1
        return true
    end if

    ' Up, OK and Info all mean "what am I watching" on a remote.
    if key = "up" or key = "info" or key = "OK" then
        showBanner()
        return false
    end if

    return false
end function
