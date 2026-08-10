sub init()
    m.top.functionName = "execute"
end sub

sub execute()
    m.top.response = HttpRequest(m.top.request)
end sub
