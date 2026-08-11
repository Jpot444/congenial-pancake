' ContentNode builders. These live in source/ rather than inside LibraryTask so
' the Favorites grid — which rebuilds items out of /api/prefs, not
' /api/library — can produce nodes the same grid components understand.

' One row of /api/library, projected onto a ContentNode. Field names mirror
' projectItem() in server.js so the two read side by side.
'
' This runs once per row in the catalogue — thousands of times for Movies — so
' it stays as close to bare field assignment as it can. In particular it does
' NOT build the proxied poster URL. Percent-encoding is a per-byte loop, and
' paying it for every row cost far more than the whole rest of the load; the
' cards do it for the dozen or so posters actually on screen instead.
function BuildItemNode(row as Object) as Object
    node = CreateObject("roSGNode", "ContentNode")

    ' addFields takes initial values, so declaring and populating is one call
    ' into the node rather than ten. At this call count that is worth having.
    ' logo is the provider's own URL, not the proxied one — it is what a
    ' favorite stores, so the web player gets identical records back.
    node.addFields({
        itemKind: AsText(row.kind),
        itemId: AsText(row.id),
        catId: AsText(row.categoryId),
        ext: AsText(row.ext),
        rating: AsText(row.rating),
        genre: AsText(row.genre),
        epgId: AsText(row.epgId),
        logo: AsText(row.logo),
        isFavorite: false
    })
    node.title = AsText(row.name)

    return node
end function

' Derived rather than stored: one string join beats a field on every node in
' the catalogue, and it is only ever needed for items on screen.
function ItemFavKey(node as Object) as String
    if node = invalid then return ""
    return FavKey(node.itemKind, node.itemId)
end function

' The proxied poster, built at display time. Safe to call on the render thread.
function ItemPoster(node as Object) as String
    if node = invalid then return ""
    return ImageUrl(node.logo)
end function

' The inverse: a node turned back into the plain object /api/prefs stores, in
' the exact shape public/app.js writes so favorites round-trip between the two
' clients without either one losing fields.
function ItemNodeToRecord(node as Object) as Object
    record = {
        kind: node.itemKind,
        id: AsNumber(node.itemId),
        name: node.title,
        logo: node.logo,
        categoryId: node.catId
    }

    if node.itemKind = "movie" then record.ext = node.ext
    if node.rating <> "" then record.rating = node.rating
    if node.genre <> "" then record.genre = node.genre
    if node.epgId <> "" then record.epgId = node.epgId

    return record
end function

' A lightweight stand-in for a category, used as the category list's content.
' The real category node stays parented to the library tree — appending it to a
' second parent would move it out of there.
function BuildCategoryProxy(title as String, categoryId as String, count as Integer, pinned as Boolean, isSearch as Boolean) as Object
    node = CreateObject("roSGNode", "ContentNode")
    node.addFields({
        catId: categoryId,
        itemCount: count,
        pinned: pinned,
        isSearch: isSearch
    })
    node.title = title
    return node
end function
