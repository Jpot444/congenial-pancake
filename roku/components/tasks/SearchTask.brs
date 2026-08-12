sub init()
    m.top.functionName = "execute"
end sub

sub execute()
    section = m.top.section
    if section = "" then section = "live"

    needle = m.top.query
    if Len(needle) < 2 then
        m.top.errorMessage = "Type at least two characters"
        m.top.done = true
        return
    end if

    clock = CreateObject("roTimespan")

    ' The first search of a cold section makes the server build its catalogue,
    ' which is the slow case /api/library was always subject to. After that it
    ' answers out of memory.
    result = HttpRequest({
        url: ApiUrl("/api/search", { tab: section, q: needle, limit: "200" }),
        timeout: 120000
    })
    if not result.ok then
        m.top.errorMessage = result.error
        m.top.done = true
        return
    end if

    payload = JsonObject(result)
    rows = payload.items
    if type(rows) <> "roArray" then rows = []

    ' Already projected by the server, the same shape /api/library hands over,
    ' so these need no field translation.
    root = CreateObject("roSGNode", "ContentNode")
    for each row in rows
        root.appendChild(BuildItemNode(row))
    end for

    print "[search] " + section + " '" + needle + "': " + root.getChildCount().ToStr() + " of " + AsText(payload.total) + " in " + clock.TotalMilliseconds().ToStr() + "ms"

    m.top.total = AsNumber(payload.total)
    m.top.items = root
    m.top.done = true
end sub
