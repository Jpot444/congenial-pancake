sub init()
    m.top.functionName = "execute"
end sub

sub execute()
    section = m.top.section
    if section = "" then section = "live"

    params = { "tab": section }
    if m.top.refresh then params.refresh = "1"

    ' A cold server has to pull the whole catalogue from the provider the first
    ' time; after that /api/library answers out of its cache in milliseconds.
    result = HttpRequest({ url: ApiUrl("/api/library", params), timeout: 120000 })

    if not result.ok then
        m.top.errorMessage = result.error
        m.top.done = true
        return
    end if

    payload = JsonObject(result)
    categories = payload.categories
    items = payload.items
    if type(categories) <> "roArray" then categories = []
    if type(items) <> "roArray" then items = []

    ' categoryId -> its node, so the items only need one pass.
    buckets = {}
    for each category in categories
        categoryId = AsText(category.id)
        if categoryId <> "" then
            node = CreateObject("roSGNode", "ContentNode")
            node.addFields({ catId: categoryId, itemCount: 0 })
            node.title = AsText(category.name)
            buckets[categoryId] = node
        end if
    end for

    kept = 0
    for each row in items
        holder = buckets[AsText(row.categoryId)]
        if holder <> invalid then
            holder.appendChild(BuildItemNode(row))
            kept = kept + 1
        end if
    end for

    ' Categories the server's filter left empty would be dead ends on a TV, so
    ' they never make it into the list — the web player hides them too.
    root = CreateObject("roSGNode", "ContentNode")
    for each category in categories
        node = buckets[AsText(category.id)]
        if node <> invalid and node.getChildCount() > 0 then
            node.itemCount = node.getChildCount()
            root.appendChild(node)
        end if
    end for

    m.top.itemTotal = kept
    m.top.catalog = root
    m.top.done = true
end sub
