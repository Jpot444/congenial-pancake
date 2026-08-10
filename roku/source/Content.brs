' ContentNode builders. These live in source/ rather than inside LibraryTask so
' the Favorites grid — which rebuilds items out of /api/prefs, not
' /api/library — can produce nodes the same grid components understand.

' One row of /api/library, projected onto a ContentNode. Field names mirror
' projectItem() in server.js so the two read side by side.
function BuildItemNode(row as Object) as Object
    node = CreateObject("roSGNode", "ContentNode")
    node.addFields({
        itemKind: "",
        itemId: "",
        catId: "",
        ext: "",
        rating: "",
        genre: "",
        epgId: "",
        rawLogo: "",
        posterUrl: "",
        favKey: "",
        isFavorite: false
    })

    kind = AsText(row.kind)
    id = AsText(row.id)

    node.title = AsText(row.name)
    node.itemKind = kind
    node.itemId = id
    node.catId = AsText(row.categoryId)
    node.ext = AsText(row.ext)
    node.rating = AsText(row.rating)
    node.genre = AsText(row.genre)
    node.epgId = AsText(row.epgId)
    node.favKey = FavKey(kind, id)

    ' The raw provider URL is kept as well as the proxied one: it is what goes
    ' into a favorite, so the web player stores identical records.
    node.rawLogo = AsText(row.logo)
    poster = ImageUrl(row.logo)
    node.posterUrl = poster
    node.hdPosterUrl = poster

    return node
end function

' The inverse: a node turned back into the plain object /api/prefs stores, in
' the exact shape public/app.js writes so favorites round-trip between the two
' clients without either one losing fields.
function ItemNodeToRecord(node as Object) as Object
    record = {
        kind: node.itemKind,
        id: AsNumber(node.itemId),
        name: node.title,
        logo: node.rawLogo,
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
