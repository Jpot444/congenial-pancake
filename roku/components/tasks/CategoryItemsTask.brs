sub init()
    m.top.functionName = "execute"
end sub

sub execute()
    section = m.top.section
    if section = "" then section = "live"

    categoryId = m.top.categoryId
    if categoryId = "" then
        m.top.errorMessage = "No category to load"
        m.top.done = true
        return
    end if

    actions = SectionActions(section)
    kind = actions[2]
    clock = CreateObject("roTimespan")

    result = HttpRequest({
        url: ApiUrl("/api/xtream", { action: actions[1], category_id: categoryId }),
        timeout: 60000
    })
    if not result.ok then
        m.top.errorMessage = result.error
        m.top.done = true
        return
    end if

    rows = result.json
    if type(rows) <> "roArray" then rows = []

    root = CreateObject("roSGNode", "ContentNode")
    for each row in rows
        root.appendChild(BuildItemNode(ProjectXtreamRow(row, kind)))
    end for

    print "[items] " + section + "/" + categoryId + ": " + root.getChildCount().ToStr() + " items, " + result.bytes.ToStr() + " bytes, " + clock.TotalMilliseconds().ToStr() + "ms"

    m.top.items = root
    m.top.done = true
end sub
