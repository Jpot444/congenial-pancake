' Entry point. Everything interesting happens in MainScene; this just puts a
' scene on screen and keeps the process alive until the user backs out of it.

sub Main(args as Dynamic)
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.SetMessagePort(port)

    scene = screen.CreateScene("MainScene")
    screen.Show()

    ' Deep links are a follow-up, but hand the launch args over now so the
    ' scene can grow into them without main.brs changing shape.
    scene.launchArgs = args

    while true
        msg = wait(0, port)
        if type(msg) = "roSGScreenEvent" then
            if msg.isScreenClosed() then return
        end if
    end while
end sub
