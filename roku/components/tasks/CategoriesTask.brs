sub init()
    m.top.functionName = "execute"
end sub

sub execute()
    section = m.top.section
    if section = "" then section = "live"

    actions = SectionActions(section)
    clock = CreateObject("roTimespan")

    result = HttpRequest({ url: ApiUrl("/api/xtream", { action: actions[0] }), timeout: 60000 })
    if not result.ok then
        m.top.errorMessage = result.error
        m.top.done = true
        return
    end if

    rows = result.json
    if type(rows) <> "roArray" then rows = []

    match = CategoryMatcher(m.top.pattern)

    root = CreateObject("roSGNode", "ContentNode")
    for each row in rows
        categoryId = AsText(row.category_id)
        name = AsText(row.category_name)
        if categoryId <> "" and MatchesCategory(match, name) then
            node = CreateObject("roSGNode", "ContentNode")
            node.addFields({ catId: categoryId, itemCount: 0, pinned: false, isSearch: false })
            node.title = name
            root.appendChild(node)
        end if
    end for

    print "[categories] " + section + ": " + root.getChildCount().ToStr() + " of " + rows.Count().ToStr() + " kept, " + clock.TotalMilliseconds().ToStr() + "ms"

    m.top.catalog = root
    m.top.done = true
end sub

' A bad pattern shouldn't blank the list — show everything instead, which is
' what buildLibrary() does on the server when the regex fails to compile.
function CategoryMatcher(pattern as String) as Object
    if pattern = "" then return invalid
    return CreateObject("roRegex", pattern, "i")
end function

function MatchesCategory(match as Object, name as String) as Boolean
    if match = invalid then return true
    return match.IsMatch(name)
end function
