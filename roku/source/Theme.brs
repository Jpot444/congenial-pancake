' The web player's palette, in the 0xRRGGBBAA form SceneGraph wants. Kept in
' one place so the channel and public/styles.css can be nudged together.

function Theme() as Object
    return {
        bg:        "0x15100FFF",
        bgRaised:  "0x1D1715FF",
        bgCard:    "0x241C1AFF",
        line:      "0x3A2D2AFF",
        lineSoft:  "0x2A211FFF",
        text:      "0xF6F1EEFF",
        muted:     "0xA3928CFF",
        mutedDim:  "0x705F5AFF",
        live:      "0xFF6B5EFF",
        brand:     "0xA21F24FF",
        brandDeep: "0x6E1418FF",
        scrim:     "0x0B0807E6"
    }
end function
