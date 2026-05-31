import unittest

from adobe.after_effects import AfterEffects
from adobe.indesign import InDesign
from adobe.illustrator import Illustrator
from adobe.photoshop import Photoshop, PhotoshopSession, connect as connect_photoshop
from adobe.premiere import Premiere
from adobe.raw import RawSession


class CapturingClient:
    target = "default"

    def __init__(self):
        self.calls = []
        self.async_calls = []

    def call(self, host, namespace, method, args=None, options=None, target=None):
        self.calls.append({"host": host, "namespace": namespace, "method": method, "args": list(args or []), "options": options or {}})
        if namespace == "app":
            if method == "getDocuments":
                return [{"id": 7, "name": "demo", "path": "C:/demo", "width": 100, "height": 50}]
            return {"photoshop": "26.0", "indesign": "19.5", "premiere": "25.6", "after-effects": "24.4", "illustrator": "28.2"}[host]
        if namespace == "document" and method == "getActive":
            payload = {"id": 7, "name": "demo", "path": "C:/demo", "width": 100, "height": 50}
            if host == "indesign":
                payload.update({"pageCount": 2, "spreadCount": 1, "typename": "Document"})
            if host == "illustrator":
                payload.update(
                    {
                        "artboardCount": 2,
                        "layerCount": 1,
                        "pageItemCount": 4,
                        "pathItemCount": 1,
                        "compoundPathItemCount": 1,
                        "placedItemCount": 1,
                        "rasterItemCount": 1,
                        "selectionCount": 3,
                        "typename": "Document",
                    }
                )
            return payload
        if namespace == "document" and method == "getById":
            return {"id": args[0], "name": "demo", "width": 100, "height": 50}
        if namespace == "document" and method in {"getLayers", "getActiveLayers"}:
            return [{"id": 11, "name": "Layer 1", "kind": "pixel", "opacity": 80, "visible": True, "isSmartObject": False}]
        if host == "photoshop" and namespace == "layer":
            if method == "getChildren":
                return [{"id": 12, "name": "Child", "kind": "pixel"}]
            return {"id": 11, "name": "Layer 1", "kind": "text", "isSmartObject": False}
        if namespace == "selection":
            if method == "get":
                return {"bounds": {"top": 1, "left": 2, "bottom": 40, "right": 50}, "docId": args[0], "solid": True, "typename": "Selection"}
            bounds = args[1] if method in {"selectRectangle", "selectEllipse"} else {"top": 0, "left": 0, "bottom": 50, "right": 50}
            return {"bounds": bounds, "docId": args[0], "solid": method in {"selectAll", "selectRectangle"}, "typename": "Selection"}
        if namespace == "channel":
            channel = {"id": 21, "name": "Alpha 1", "kind": "maskedArea", "opacity": 50, "visible": True, "typename": "Channel"}
            if method in {"getChannels", "getActiveChannels", "getComponentChannels"}:
                return [channel]
            if method == "getByName":
                return channel if args[1] == "Alpha 1" else None
            if method == "add":
                return {**channel, "name": args[1] or "Alpha 2"}
            if method == "remove":
                return channel
        if host == "indesign" and namespace == "text":
            text_frame = {
                "id": 51,
                "name": "Frame 1",
                "index": 0,
                "contents": "Hello",
                "overflows": False,
                "geometricBounds": [0, 0, 100, 200],
                "parentStoryId": 61,
                "parentStoryName": "Story 1",
                "parentPageId": 31,
                "parentPageName": "1",
                "isValid": True,
                "typename": "TextFrame",
            }
            if method == "getTextFrames":
                return [text_frame]
            if method == "getTextFrameByName":
                return text_frame if args[1] == "Frame 1" else None
            if method == "getSelectedText":
                return {
                    "contents": "selected",
                    "parentStoryId": 61,
                    "parentStoryName": "Story 1",
                    "index": 3,
                    "length": 8,
                    "isValid": True,
                    "typename": "Text",
                }
            if method == "setFrameContents":
                return {**text_frame, "contents": args[2]}
        if namespace == "text":
            payload = {
                "layerId": args[0] if args else 11,
                "contents": "Hello",
                "isParagraphText": False,
                "isPointText": True,
                "orientation": "horizontal",
                "textClickPoint": {"x": 12, "y": 24},
                "typename": "TextItem",
                "characterStyle": {"font": "ArialMT", "size": 24, "tracking": 10},
                "paragraphStyle": {"justification": "left", "hyphenation": False},
            }
            if method == "getActive":
                return payload
            if method == "getByLayerId":
                return payload if args[0] == 11 else None
            if method == "setContents":
                return {**payload, "contents": args[1]}
            if method == "setCharacterStyle":
                return {**payload, "characterStyle": {**payload["characterStyle"], **args[1]}}
            if method == "setParagraphStyle":
                return {**payload, "paragraphStyle": {**payload["paragraphStyle"], **args[1]}}
            if method == "setTextClickPoint":
                return {**payload, "textClickPoint": args[1]}
            if method == "setOrientation":
                return {**payload, "orientation": args[1]}
            if method in {"resetCharacterStyle", "convertToParagraphText", "convertToPointText", "convertToShape", "createWorkPath"}:
                return payload
        if namespace == "filter":
            return {"id": args[0], "name": "Layer 1", "kind": "pixel", "lastFilter": method}
        if namespace == "smartObject":
            return {"id": args[0], "name": "Layer 1", "kind": "smartObject", "isSmartObject": True}
        if namespace == "export":
            if method == "getPresets":
                return [
                    {"name": "png", "format": "png", "asCopy": True, "options": {"compression": 6}},
                    {"name": "jpg_high", "format": "jpg", "asCopy": True, "options": {"quality": 12}},
                ]
            if method == "exportWithPreset":
                return {"id": args[0]["id"], "name": "demo", "path": args[0]["path"], "width": 100, "height": 50}
        if namespace == "page":
            page = {
                "id": 31,
                "name": "1",
                "index": 0,
                "documentOffset": 0,
                "side": "rightHand",
                "bounds": [0, 0, 800, 600],
                "parentId": 41,
                "parentName": "Spread 1",
                "isValid": True,
                "typename": "Page",
            }
            if method == "getPages":
                return [page, {**page, "id": 32, "name": "2", "index": 1, "documentOffset": 1}]
            if method == "getActive":
                return page
            if method == "getByName":
                return page if args[1] == "1" else None
            if method == "select":
                return page
        if namespace == "spread":
            spread = {
                "id": 41,
                "name": "Spread 1",
                "label": "Spread 1",
                "index": 0,
                "pageCount": 2,
                "pageNames": ["1", "2"],
                "parentId": 7,
                "parentName": "demo",
                "isValid": True,
                "typename": "Spread",
            }
            if method == "getSpreads":
                return [spread]
            if method == "getActive":
                return spread
            if method == "getByName":
                return spread if args[1] == "Spread 1" else None
        if host == "indesign" and namespace == "story":
            story = {
                "id": 61,
                "name": "Story 1",
                "index": 0,
                "contents": "Hello story",
                "length": 11,
                "textContainerCount": 1,
                "paragraphCount": 2,
                "isValid": True,
                "typename": "Story",
            }
            if method == "getStories":
                return [story]
            if method in {"getByName", "getByTextFrameId"}:
                return story if args[1] in {"Story 1", 51} else None
            if method == "setContents":
                return {**story, "contents": args[2], "length": len(args[2])}
        if host == "indesign" and namespace == "style":
            paragraph_style = {
                "id": 71,
                "name": "Body",
                "index": 0,
                "isValid": True,
                "typename": "ParagraphStyle",
                "appliedFont": "Minion Pro",
                "fontStyle": "Regular",
                "pointSize": 10,
                "leading": 12,
                "tracking": 0,
                "justification": "left",
            }
            character_style = {
                "id": 81,
                "name": "Emphasis",
                "index": 0,
                "isValid": True,
                "typename": "CharacterStyle",
                "appliedFont": "Minion Pro",
                "fontStyle": "Italic",
                "pointSize": 10,
                "leading": 12,
                "tracking": 5,
            }
            if method == "getParagraphStyles":
                return [paragraph_style]
            if method == "getCharacterStyles":
                return [character_style]
            if method == "getParagraphStyleByName":
                return paragraph_style if args[1] == "Body" else None
            if method == "getCharacterStyleByName":
                return character_style if args[1] == "Emphasis" else None
            if method == "setParagraphStyleProperties":
                return {**paragraph_style, **args[2]}
            if method == "setCharacterStyleProperties":
                return {**character_style, **args[2]}
        if host == "indesign" and namespace == "swatch":
            swatch = {
                "id": 91,
                "name": "Brand Blue",
                "model": "process",
                "space": "RGB",
                "colorValue": [10, 20, 200],
                "isValid": True,
                "typename": "Color",
            }
            if method == "getSwatches":
                return [swatch]
            if method == "getByName":
                return swatch if args[1] == "Brand Blue" else None
            if method == "addColor":
                return {**swatch, **args[1], "id": 92}
        if host == "indesign" and namespace == "link":
            link = {
                "id": 101,
                "name": "hero.png",
                "filePath": "C:/assets/hero.png",
                "status": "normal",
                "linkType": "PNG",
                "isValid": True,
                "typename": "Link",
            }
            if method == "getLinks":
                return [link]
            if method == "getByName":
                return link if args[1] == "hero.png" else None
            if method == "update":
                return {**link, "status": "updated"}
            if method == "relink":
                return {**link, "filePath": args[2], "status": "normal"}
        if host == "indesign" and namespace == "export":
            if method == "exportFile":
                return {"id": args[0]["id"], "path": args[0]["path"], "format": args[0]["format"], "options": args[0]["options"]}
        if host == "indesign" and namespace == "package":
            if method == "packageForPrint":
                return {"ok": True, "path": args[0]["path"], "document": {"id": args[0]["id"], "name": "demo"}}
        if host == "illustrator" and namespace == "artboard":
            artboards = [
                {
                    "index": 0,
                    "name": "Artboard 1",
                    "artboardRect": [0, 500, 500, 0],
                    "rulerOrigin": [0, 0],
                    "rulerPAR": 1,
                    "showCenter": True,
                    "showCrossHairs": False,
                    "showSafeAreas": False,
                    "typename": "Artboard",
                },
                {
                    "index": 1,
                    "name": "Artboard 2",
                    "artboardRect": [500, 500, 1000, 0],
                    "rulerOrigin": [0, 0],
                    "rulerPAR": 1,
                    "showCenter": False,
                    "showCrossHairs": True,
                    "showSafeAreas": True,
                    "typename": "Artboard",
                },
            ]
            if method == "getArtboards":
                return artboards
            if method == "getActive":
                return artboards[1]
            if method == "getActiveIndex":
                return 1
        if host == "illustrator" and namespace == "layer":
            layer = {
                "id": "layer-1",
                "index": 0,
                "name": "Artwork",
                "visible": True,
                "locked": False,
                "printable": True,
                "preview": True,
                "opacity": 85,
                "hasSelectedArtwork": True,
                "parentName": "demo",
                "parentTypename": "Document",
                "layerCount": 1,
                "pageItemCount": 2,
                "typename": "Layer",
            }
            child = {**layer, "id": "layer-2", "index": 0, "name": "Icons", "parentName": "Artwork", "parentTypename": "Layer", "layerCount": 0, "pageItemCount": 1}
            if method == "getLayers":
                return [layer]
            if method == "getByName":
                return layer if args[0] == "Artwork" else None
            if method == "getChildren":
                return [child] if args[0] in {"layer-1", "Artwork", 0} else []
        if host == "illustrator" and namespace == "pageItem":
            item = {
                "id": "item-1",
                "index": 0,
                "name": "Logo",
                "itemType": "PathItem",
                "hidden": False,
                "locked": False,
                "selected": True,
                "editable": True,
                "sliced": False,
                "position": [10, 490],
                "geometricBounds": [10, 490, 110, 390],
                "visibleBounds": [8, 492, 112, 388],
                "controlBounds": [5, 495, 115, 385],
                "width": 100,
                "height": 100,
                "opacity": 100,
                "parentName": "Artwork",
                "parentTypename": "Layer",
                "layerName": "Artwork",
                "note": "brand",
                "url": "https://example.com",
                "typename": "PathItem",
            }
            compound = {**item, "id": "compound-1", "index": 1, "name": "Compound Logo", "itemType": "CompoundPathItem", "selected": True, "typename": "CompoundPathItem"}
            placed = {**item, "id": "placed-1", "index": 2, "name": "Placed", "itemType": "PlacedItem", "selected": False, "typename": "PlacedItem"}
            raster = {**item, "id": "raster-1", "index": 3, "name": "Raster", "itemType": "RasterItem", "selected": True, "typename": "RasterItem"}
            if method == "getPageItems":
                return [item, compound, placed, raster]
            if method == "getSelected":
                return [item, compound, raster]
            if method == "getByName":
                return item if args[0] == "Logo" else None
            if method == "getLayerItems":
                return [item] if args[0] in {"layer-1", "Artwork", 0} else []
        if host == "illustrator" and namespace == "pathItem":
            path = {
                "id": "path-1",
                "index": 0,
                "name": "Logo Path",
                "itemType": "PathItem",
                "hidden": False,
                "locked": False,
                "selected": True,
                "editable": True,
                "sliced": False,
                "position": [10, 490],
                "geometricBounds": [10, 490, 110, 390],
                "visibleBounds": [8, 492, 112, 388],
                "controlBounds": [5, 495, 115, 385],
                "width": 100,
                "height": 100,
                "opacity": 100,
                "parentName": "Artwork",
                "parentTypename": "Layer",
                "layerName": "Artwork",
                "note": "brand",
                "url": "https://example.com",
                "area": 1024.5,
                "closed": True,
                "clipping": False,
                "evenodd": True,
                "filled": True,
                "fillColor": {"typename": "RGBColor", "red": 255, "green": 0, "blue": 0},
                "fillOverprint": False,
                "stroked": True,
                "strokeColor": {"typename": "CMYKColor", "cyan": 0, "magenta": 0, "yellow": 0, "black": 100},
                "strokeWidth": 2,
                "strokeCap": "RoundEndCap",
                "strokeJoin": "RoundEndJoin",
                "strokeDashes": [4, 2],
                "strokeDashOffset": 1,
                "strokeMiterLimit": 10,
                "strokeOverprint": False,
                "guides": False,
                "length": 128.5,
                "pathPointCount": 4,
                "selectedPathPointCount": 2,
                "pixelAligned": True,
                "polarity": "Positive",
                "typename": "PathItem",
            }
            if method == "getPathItems":
                return [path]
            if method == "getSelected":
                return [path]
            if method == "getByName":
                return path if args[0] == "Logo Path" else None
            if method == "getLayerItems":
                return [path] if args[0] in {"layer-1", "Artwork", 0} else []
        if host == "illustrator" and namespace == "compoundPath":
            compound = {
                "id": "compound-1",
                "index": 0,
                "name": "Compound Logo",
                "itemType": "CompoundPathItem",
                "hidden": False,
                "locked": False,
                "selected": True,
                "editable": True,
                "sliced": False,
                "position": [10, 490],
                "geometricBounds": [10, 490, 110, 390],
                "visibleBounds": [8, 492, 112, 388],
                "controlBounds": [5, 495, 115, 385],
                "width": 100,
                "height": 100,
                "opacity": 100,
                "parentName": "Artwork",
                "parentTypename": "Layer",
                "layerName": "Artwork",
                "note": "compound",
                "url": "https://example.com/compound",
                "pathItemCount": 1,
                "typename": "CompoundPathItem",
            }
            child_path = {
                "id": "path-2",
                "index": 0,
                "name": "Compound Child",
                "itemType": "PathItem",
                "hidden": False,
                "locked": False,
                "selected": False,
                "editable": True,
                "sliced": False,
                "position": [20, 480],
                "geometricBounds": [20, 480, 100, 400],
                "visibleBounds": [18, 482, 102, 398],
                "controlBounds": [15, 485, 105, 395],
                "width": 80,
                "height": 80,
                "opacity": 100,
                "parentName": "Compound Logo",
                "parentTypename": "CompoundPathItem",
                "layerName": "Artwork",
                "area": 512,
                "closed": True,
                "clipping": False,
                "evenodd": False,
                "filled": True,
                "fillColor": {"typename": "GrayColor", "gray": 50},
                "stroked": False,
                "pathPointCount": 3,
                "selectedPathPointCount": 0,
                "typename": "PathItem",
            }
            if method == "getCompoundPathItems":
                return [compound]
            if method == "getSelected":
                return [compound]
            if method == "getByName":
                return compound if args[0] == "Compound Logo" else None
            if method == "getLayerItems":
                return [compound] if args[0] in {"layer-1", "Artwork", 0} else []
            if method == "getPathItems":
                return [child_path] if args[0] in {"compound-1", "Compound Logo", 0} else []
        if host == "illustrator" and namespace == "placedItem":
            placed = {
                "id": "placed-1",
                "index": 0,
                "name": "Placed",
                "itemType": "PlacedItem",
                "hidden": False,
                "locked": False,
                "selected": False,
                "editable": True,
                "sliced": False,
                "position": [100, 400],
                "geometricBounds": [100, 400, 260, 240],
                "visibleBounds": [100, 400, 260, 240],
                "controlBounds": [98, 402, 262, 238],
                "width": 160,
                "height": 160,
                "opacity": 90,
                "parentName": "Artwork",
                "parentTypename": "Layer",
                "layerName": "Artwork",
                "note": "linked",
                "url": "https://example.com/placed",
                "filePath": "C:/assets/logo.pdf",
                "fileName": "logo.pdf",
                "boundingBox": [100, 400, 260, 240],
                "matrix": {"mValueA": 1, "mValueD": 1, "mValueTX": 0, "mValueTY": 0},
                "typename": "PlacedItem",
            }
            if method == "getPlacedItems":
                return [placed]
            if method == "getSelected":
                return []
            if method == "getByName":
                return placed if args[0] == "Placed" else None
            if method == "getLayerItems":
                return [placed] if args[0] in {"layer-1", "Artwork", 0} else []
        if host == "illustrator" and namespace == "rasterItem":
            raster = {
                "id": "raster-1",
                "index": 0,
                "name": "Raster",
                "itemType": "RasterItem",
                "hidden": False,
                "locked": False,
                "selected": True,
                "editable": True,
                "sliced": False,
                "position": [300, 300],
                "geometricBounds": [300, 300, 500, 100],
                "visibleBounds": [300, 300, 500, 100],
                "controlBounds": [298, 302, 502, 98],
                "width": 200,
                "height": 200,
                "opacity": 75,
                "parentName": "Artwork",
                "parentTypename": "Layer",
                "layerName": "Artwork",
                "note": "photo",
                "url": "https://example.com/raster",
                "filePath": "C:/assets/photo.png",
                "fileName": "photo.png",
                "boundingBox": [300, 300, 500, 100],
                "matrix": {"mValueA": 1, "mValueD": 1},
                "embedded": False,
                "bitsPerChannel": 8,
                "channels": 4,
                "colorants": ["Cyan", "Magenta", "Yellow", "Black"],
                "colorizedGrayscale": False,
                "imageColorSpace": "CMYK",
                "overprint": True,
                "typename": "RasterItem",
            }
            if method == "getRasterItems":
                return [raster]
            if method == "getSelected":
                return [raster]
            if method == "getByName":
                return raster if args[0] == "Raster" else None
            if method == "getLayerItems":
                return [raster] if args[0] in {"layer-1", "Artwork", 0} else []
        if namespace == "raw" and method == "evalJs":
            return {"source": args[0], "args": list(args[1:])}
        if namespace == "raw" and method == "getPath":
            return {"path": list(args[0]), "depth": args[1]}
        if namespace == "raw" and method == "callPath":
            return {"path": list(args[0]), "args": list(args[1]), "depth": args[2]}
        if host == "premiere" and namespace == "project":
            sequence = {
                "id": "seq-1",
                "sequenceId": "sequence-1",
                "name": "Main edit",
                "duration": 120.0,
                "timebase": 25,
                "typename": "Sequence",
            }
            root_item = {
                "id": "root",
                "name": "Project Root",
                "itemType": "bin",
                "treePath": "/",
                "childCount": 2,
                "isBin": True,
                "typename": "FolderItem",
            }
            if method == "getActive":
                return {"id": "project-1", "guid": "project-1", "name": "cut", "path": "C:/cut", "itemCount": 3}
            if method == "getSequences":
                return [sequence]
            if method == "getActiveSequence":
                return sequence
            if method == "getRootItem":
                return root_item
            if method == "importFiles":
                return [
                    {
                        "id": "media-2",
                        "name": "new.mov",
                        "itemType": "clip",
                        "mediaPath": args[0]["filePaths"][0],
                        "parentId": args[0]["targetBin"] or "root",
                        "isClip": True,
                        "isOffline": False,
                        "typename": "ClipProjectItem",
                    }
                ]
        if host == "premiere" and namespace == "projectItem":
            bin_item = {
                "id": "bin-1",
                "name": "Dailies",
                "itemType": "bin",
                "treePath": "/Dailies",
                "parentId": "root",
                "childCount": 1,
                "isBin": True,
                "typename": "FolderItem",
            }
            media_item = {
                "id": "media-1",
                "name": "shot.mov",
                "itemType": "clip",
                "mediaPath": "C:/media/shot.mov",
                "treePath": "/Dailies/shot.mov",
                "parentId": "bin-1",
                "isClip": True,
                "canProxy": True,
                "hasProxy": False,
                "isOffline": False,
                "typename": "ClipProjectItem",
            }
            if method == "getChildren":
                return [bin_item] if args[0] == "root" else [media_item]
            if method == "getSelected":
                return [media_item]
            if method == "findByMediaPath":
                return [media_item] if "shot" in args[1] else []
        if host == "premiere" and namespace == "bin" and method == "create":
            return {
                "id": "bin-2",
                "name": args[0]["name"],
                "itemType": "bin",
                "treePath": f"/{args[0]['name']}",
                "parentId": args[0]["parentId"],
                "childCount": 0,
                "isBin": True,
                "typename": "FolderItem",
            }
        if host == "premiere" and namespace == "sequence":
            if method == "getVideoTracks":
                return [{"id": "v1", "name": "V1", "index": 0, "mediaType": "video", "isLocked": False, "isMuted": False, "isTargeted": True}]
            if method == "getAudioTracks":
                return [{"id": "a1", "name": "A1", "index": 0, "mediaType": "audio", "isLocked": False, "isMuted": True, "isTargeted": False}]
        if host == "premiere" and namespace == "track" and method == "getClips":
            if args[1] == "audio":
                return [{"id": "clip-a", "name": "dialog.wav", "mediaPath": "C:/media/dialog.wav", "start": 0, "end": 30, "duration": 30, "isEnabled": True}]
            return [{"id": "clip-v", "name": "shot.mov", "projectItemId": "item-1", "mediaPath": "C:/media/shot.mov", "start": 0, "end": 30, "duration": 30, "isEnabled": True, "isSelected": True}]
        if host == "premiere" and namespace == "clip" and method == "getSelected":
            return [{"id": "clip-v", "name": "shot.mov", "projectItemId": "item-1", "mediaPath": "C:/media/shot.mov", "isSelected": True}]
        if host == "premiere" and namespace == "marker":
            marker = {"id": "marker-1", "name": "Beat", "comments": "cut here", "start": 12, "duration": 1, "markerType": "comment", "typename": "Marker"}
            if method == "getMarkers":
                return [marker]
            if method == "create":
                return {**marker, **args[1], "id": "marker-2"}
        if host == "after-effects" and namespace == "project":
            comp = {
                "id": 1,
                "index": 1,
                "name": "Main Comp",
                "typeName": "Composition",
                "itemType": "composition",
                "width": 1920,
                "height": 1080,
                "duration": 12.5,
                "frameRate": 24,
                "numLayers": 3,
                "workAreaStart": 0,
                "workAreaDuration": 10,
                "selected": True,
                "isActive": True,
                "typename": "CompItem",
            }
            footage = {
                "id": 2,
                "index": 2,
                "name": "plate.mov",
                "typeName": "Footage",
                "itemType": "footage",
                "width": 1920,
                "height": 1080,
                "duration": 12.5,
                "frameRate": 24,
                "hasVideo": True,
                "hasAudio": False,
                "filePath": "C:/plates/plate.mov",
                "missingFootage": False,
                "parentFolderId": 3,
                "parentFolderName": "Plates",
                "typename": "FootageItem",
            }
            folder = {
                "id": 3,
                "index": 3,
                "name": "Plates",
                "typeName": "Folder",
                "itemType": "folder",
                "itemCount": 1,
                "typename": "FolderItem",
            }
            if method == "getActive":
                return {"name": "cut", "path": "C:/cut", "itemCount": 3}
            if method == "getItems":
                return [comp, footage, folder]
            if method == "getCompositions":
                return [comp]
            if method == "getFootageItems":
                return [footage]
            if method == "getFolders":
                return [folder]
            if method == "getActiveItem":
                return comp
            if method == "getSelectedItems":
                return [comp]
        if host == "after-effects" and namespace == "item":
            if method == "getById":
                return {"id": args[0], "index": 1, "name": "Main Comp", "typeName": "Composition", "itemType": "composition", "typename": "CompItem"}
            if method == "getByName":
                return [{"id": 1, "index": 1, "name": args[0], "typeName": "Composition", "itemType": "composition", "typename": "CompItem"}]
        if host == "after-effects" and namespace == "layer":
            text_layer = {
                "id": 11,
                "index": 1,
                "name": "Title",
                "typeName": "TextLayer",
                "layerType": "text",
                "compId": 1,
                "sourceId": None,
                "sourceName": None,
                "selected": True,
                "enabled": True,
                "solo": False,
                "locked": False,
                "shy": False,
                "isText": True,
                "startTime": 0,
                "inPoint": 0,
                "outPoint": 12.5,
                "stretch": 100,
                "width": 1920,
                "height": 1080,
                "hasVideo": True,
                "hasAudio": False,
                "typename": "TextLayer",
            }
            av_layer = {
                **text_layer,
                "id": 12,
                "index": 2,
                "name": "Plate",
                "typeName": "AVLayer",
                "layerType": "av",
                "sourceId": 2,
                "sourceName": "plate.mov",
                "selected": False,
                "isText": False,
                "typename": "Layer",
            }
            if method == "getLayers":
                return [text_layer, av_layer]
            if method == "getSelected":
                return [text_layer]
            if method == "getById":
                return text_layer if args[1] in {11, "11", "Title"} else None
        if host == "after-effects" and namespace == "mask":
            if method == "getMasks":
                return [
                    {
                        "id": "mask-1",
                        "index": 1,
                        "name": "Mask 1",
                        "maskMode": "add",
                        "inverted": False,
                        "locked": False,
                        "rotoBezier": True,
                        "opacity": 100,
                        "feather": [2, 2],
                        "expansion": 0,
                        "typename": "MaskPropertyGroup",
                    }
                ]
        if host == "after-effects" and namespace == "effect":
            effect = {
                "id": "fx-1",
                "index": 1,
                "name": "Gaussian Blur",
                "matchName": "ADBE Gaussian Blur 2",
                "enabled": True,
                "active": True,
                "selected": False,
                "propertyCount": 2,
                "typename": "EffectPropertyGroup",
            }
            if method == "getEffects":
                return [effect]
            if method == "getByName":
                return effect if args[2] in {"Gaussian Blur", "ADBE Gaussian Blur 2"} else None
        if host == "after-effects" and namespace == "text":
            source_text = {
                "text": "Hello",
                "font": "ArialMT",
                "fontSize": 48,
                "fillColor": [1, 1, 1],
                "strokeColor": [0, 0, 0],
                "tracking": 10,
                "justification": "center",
                "typename": "TextDocument",
            }
            if method == "getSourceText":
                return source_text if args[1] in {11, "11", "Title"} else None
            if method == "setSourceText":
                return {**source_text, **args[2]}
        if host == "after-effects" and namespace == "renderQueue":
            render_queue = {
                "numItems": 1,
                "canQueueInAME": True,
                "queueNotify": False,
                "rendering": False,
                "typename": "RenderQueue",
            }
            render_item = {
                "id": "rq-1",
                "index": 1,
                "compId": 1,
                "compName": "Main Comp",
                "status": "QUEUED",
                "elapsedSeconds": None,
                "render": True,
                "skipFrames": 0,
                "queueItemNotify": False,
                "timeSpanStart": 0,
                "timeSpanDuration": 10,
                "numOutputModules": 1,
                "templates": ["Best Settings"],
                "settings": {"Quality": "Best"},
                "typename": "RenderQueueItem",
            }
            if method == "get":
                return render_queue
            if method == "getItems":
                return [render_item]
            if method == "getItemByIndex":
                return render_item if args[0] == 1 else None
            if method == "addComposition":
                return {**render_item, "compId": args[0]["comp"], "settings": args[0].get("settings") or render_item["settings"]}
            if method == "queueSelectedCompositions":
                return [render_item]
            if method in {"render", "pauseRendering", "stopRendering", "showWindow", "queueInAME"}:
                return render_queue
            if method == "setQueueNotify":
                return {**render_queue, "queueNotify": args[0]}
        if host == "after-effects" and namespace == "renderQueueItem":
            render_item = {
                "id": "rq-1",
                "index": args[0],
                "compId": 1,
                "compName": "Main Comp",
                "status": "QUEUED",
                "render": True,
                "skipFrames": 0,
                "queueItemNotify": False,
                "timeSpanStart": 0,
                "timeSpanDuration": 10,
                "numOutputModules": 1,
                "templates": ["Best Settings"],
                "settings": {"Quality": "Best"},
                "typename": "RenderQueueItem",
            }
            if method == "applyTemplate":
                return {**render_item, "settings": {"template": args[1]}}
            if method == "setSettings":
                return {**render_item, "settings": args[1]}
            if method == "setRender":
                return {**render_item, "render": args[1]}
            if method == "setQueueItemNotify":
                return {**render_item, "queueItemNotify": args[1]}
        if host == "after-effects" and namespace == "outputModule":
            output_module = {
                "itemIndex": args[0] if args else 1,
                "index": args[1] if len(args) > 1 else 1,
                "name": "Lossless",
                "filePath": "C:/renders/Main Comp.mov",
                "outputPath": "C:/renders/Main Comp.mov",
                "includeSourceXMP": True,
                "postRenderAction": "NONE",
                "templates": ["Lossless", "H.264"],
                "settings": {"Format": "QuickTime"},
                "typename": "OutputModule",
            }
            if method == "getModules":
                return [{**output_module, "index": 1}]
            if method == "getByIndex":
                return output_module if args[1] == 1 else None
            if method == "applyTemplate":
                return {**output_module, "name": args[2]}
            if method == "setSettings":
                return {**output_module, "settings": args[2]}
            if method == "setOutputPath":
                return {**output_module, "filePath": args[2], "outputPath": args[2]}
            if method == "saveAsTemplate":
                return {**output_module, "templates": [*output_module["templates"], args[2]]}
        if host == "premiere" and namespace == "encoder":
            if method == "getManager":
                return {"isAMEInstalled": True, "typename": "EncoderManager"}
            if method == "getPresets":
                return [
                    {
                        "name": "H.264 Match Source",
                        "path": "C:/presets/h264.epr",
                        "format": "H.264",
                        "extension": "mp4",
                        "typename": "EncoderPreset",
                    }
                ]
            if method == "getExportFileExtension":
                return "mp4"
            if method == "encodeFile":
                return {
                    "jobId": "job-file",
                    "status": "queued",
                    "outputPath": args[0]["outputPath"],
                    "presetPath": args[0]["presetPath"],
                    "sourceName": args[0]["sourcePath"],
                    "removeUponCompletion": args[0]["removeUponCompletion"],
                    "typename": "ExportJob",
                }
            if method == "encodeProjectItem":
                return {
                    "jobId": "job-item",
                    "status": "queued",
                    "outputPath": args[0]["outputPath"],
                    "presetPath": args[0]["presetPath"],
                    "sourceId": args[0]["projectItem"],
                    "typename": "ExportJob",
                }
            if method == "exportSequence":
                return {
                    "jobId": "job-sequence",
                    "status": "queued",
                    "outputPath": args[0]["outputPath"],
                    "presetPath": args[0]["presetPath"],
                    "sourceId": args[0]["sequence"],
                    "exportType": args[0]["exportType"],
                    "typename": "ExportJob",
                }
        if host == "premiere" and namespace == "export":
            if method == "exportFrame":
                return {
                    "jobId": "job-frame",
                    "status": "exported",
                    "outputPath": args[0]["outputPath"],
                    "sourceId": args[0]["sequence"],
                    "typename": "ExportJob",
                }
        if namespace == "project":
            return {"name": "cut", "path": "C:/cut", "itemCount": 3}
        return {"ok": True}

    async def call_async(self, host, namespace, method, args=None, options=None, target=None):
        self.async_calls.append({"host": host, "namespace": namespace, "method": method, "args": list(args or []), "options": options or {}})
        return {"method": method}


class FacadeTests(unittest.TestCase):
    def test_photoshop_contract(self):
        client = CapturingClient()
        app = Photoshop(client=client)
        self.assertEqual(app.version, "26.0")
        self.assertEqual(app.documents[0].name, "demo")
        self.assertEqual(app.activeDocument.width, 100)
        self.assertEqual(app.activeDocument.layers[0].opacity, 80)
        self.assertEqual(app.activeDocument.activeLayers[0].name, "Layer 1")
        self.assertEqual(app.activeLayers[0].name, "Layer 1")
        self.assertEqual(app.active_layer.name, "Layer 1")
        self.assertFalse(app.active_layer.hasChildren)
        self.assertEqual(app.active_layer.layers[0].name, "Child")
        self.assertEqual(app.activeText.contents, "Hello")
        self.assertEqual(app.active_text.characterStyle.size, 24)
        self.assertEqual(app.exportPresets[0].format, "png")
        self.assertEqual(app.selection.bounds["top"], 1)
        self.assertEqual(app.channels[0].name, "Alpha 1")
        selection = app.activeDocument.selection
        self.assertEqual(selection.bounds["right"], 50)
        self.assertEqual(selection.doc_id, 7)
        self.assertEqual(selection.typename, "Selection")
        self.assertTrue(selection.selectRectangle({"top": 4, "left": 5, "bottom": 9, "right": 10}).solid)
        self.assertEqual(client.calls[-1]["method"], "selectRectangle")
        self.assertEqual(selection.select_all(command_name="All").docId, 7)
        self.assertEqual(client.calls[-1]["options"]["commandName"], "All")
        selection.select_ellipse({"top": 1, "left": 1, "bottom": 2, "right": 2})
        selection.selectPolygon([{"x": 1, "y": 2}], commandName="Poly")
        selection.select_row(4)
        selection.selectColumn(5)
        selection.expand(2)
        selection.contract(1)
        selection.feather(0.5)
        selection.smooth(2)
        selection.grow(12)
        selection.translateBoundary(1, 2)
        selection.inverse()
        selection.deselect()
        selection.save("Saved selection")
        channel = app.activeDocument.channels[0]
        self.assertEqual(channel.name, "Alpha 1")
        self.assertEqual(channel.kind, "maskedArea")
        self.assertEqual(app.activeDocument.activeChannels[0].opacity, 50)
        self.assertEqual(app.activeDocument.component_channels[0].typename, "Channel")
        self.assertEqual(app.activeDocument.getChannel("Alpha 1").visible, True)
        app.activeDocument.get_channel("Alpha 1").remove(command_name="Remove")
        self.assertEqual(client.calls[-1]["options"]["commandName"], "Remove")
        self.assertEqual(app.dom.app.activeDocument.get()["path"], ["app", "activeDocument"])
        self.assertEqual(app.dom.app.activeDocument.createLayer({"name": "x"}, modal=True)["path"], ["app", "activeDocument", "createLayer"])
        with app.executeAsModal(commandName="Hide"):
            app.action.batchPlay([{"_obj": "hide"}])
        self.assertEqual(client.calls[-1]["options"]["commandName"], "Hide")
        with app.execute_as_modal(command_name="Tone"):
            app.batch_play([{"_obj": "levels"}])
        self.assertEqual(client.calls[-1]["options"]["commandName"], "Tone")
        app.activeDocument.saveAs("C:/x.psd", commandName="Save")
        app.activeDocument.export("C:/x.png", timeout_ms=3)
        app.activeDocument.export_with_preset("jpg_high", "C:/x.jpg", options={"quality": 10})
        self.assertEqual(client.calls[-1]["namespace"], "export")
        self.assertEqual(client.calls[-1]["args"][0]["options"]["quality"], 10)
        app.activeDocument.exports.png("C:/x.png")
        self.assertEqual(client.calls[-1]["method"], "exportWithPreset")
        self.assertEqual(app.activeDocument.exports.presets[1].name, "jpg_high")
        text = app.activeLayer.text_item
        self.assertEqual(text.contents, "Hello")
        self.assertTrue(text.isPointText)
        self.assertEqual(text.textClickPoint["x"], 12)
        self.assertEqual(text.setContents("World", commandName="Text").contents, "World")
        self.assertEqual(client.calls[-1]["options"]["commandName"], "Text")
        self.assertEqual(text.set_character_style({"size": 36}).character_style.size, 36)
        self.assertEqual(text.characterStyle.update(tracking=25).characterStyle.tracking, 25)
        self.assertEqual(text.paragraph_style.update({"justification": "center"}).paragraphStyle.justification, "center")
        text.setTextClickPoint({"x": 1, "y": 2})
        text.set_orientation("vertical")
        text.characterStyle.reset()
        text.convertToParagraphText()
        text.convert_to_point_text()
        text.convert_to_shape()
        text.createWorkPath()
        layer = app.activeLayer
        self.assertFalse(layer.isSmartObject)
        self.assertEqual(layer.filters.apply_gaussian_blur(2, command_name="Blur").id, 11)
        self.assertEqual(client.calls[-1]["method"], "applyGaussianBlur")
        self.assertEqual(client.calls[-1]["options"]["commandName"], "Blur")
        layer.filters.apply("applyHighPass", 4)
        layer.filters.applySharpen()
        layer.filters.applySmartBlur(3, 12, "high")
        self.assertTrue(layer.smart_object.convert_to_smart_object(command_name="Smart").isSmartObject)
        self.assertEqual(client.calls[-1]["options"]["commandName"], "Smart")
        layer.smartObject.newSmartObjectViaCopy()
        layer.smartObject.editContents()
        layer.smartObject.replace_contents("C:/replacement.psb")
        app.activeLayer.hide()
        self.assertTrue(client.calls[-1]["options"]["modal"])
        self.assertIsInstance(connect_photoshop(broker_url="http://x"), Photoshop)

    def test_document_refresh_and_session_modal(self):
        client = CapturingClient()
        session = PhotoshopSession(client)
        doc = session.app.active_document
        self.assertIs(doc.refresh(), doc)
        with session.modal("Batch"):
            session.action.batch_play([{"_obj": "select"}])
        self.assertEqual(client.calls[-1]["options"]["commandName"], "Batch")

    def test_indesign_and_premiere(self):
        indesign_client = CapturingClient()
        indesign = InDesign(client=indesign_client)
        self.assertEqual(indesign.active_document.name, "demo")
        self.assertEqual(indesign.version, "19.5")
        self.assertEqual(indesign.activeDocument.pageCount, 2)
        self.assertEqual(indesign.activeDocument.spread_count, 1)
        self.assertEqual(indesign.activeDocument.path, "C:/demo")
        self.assertEqual(indesign.activeDocument.typename, "Document")
        self.assertEqual(indesign.active_page.bounds[2], 800)
        self.assertEqual(indesign.active_page.side, "rightHand")
        self.assertEqual(indesign.active_page.parent_id, 41)
        self.assertTrue(indesign.active_page.isValid)
        self.assertEqual(indesign.activePage.parentName, "Spread 1")
        self.assertEqual(indesign.active_spread.pageNames, ["1", "2"])
        self.assertEqual(indesign.activeSpread.label, "Spread 1")
        self.assertTrue(indesign.active_spread.is_valid)
        self.assertEqual(indesign.active_spread.parentId, 7)
        self.assertEqual(indesign.activeDocument.pages[1].documentOffset, 1)
        self.assertEqual(indesign.activeDocument.spreads[0].page_count, 2)
        self.assertEqual(indesign.activeDocument.get_page("1").typename, "Page")
        self.assertEqual(indesign.activeDocument.getPage("1").index, 0)
        self.assertIsNone(indesign.activeDocument.get_page("missing"))
        self.assertEqual(indesign.activeDocument.getSpread("Spread 1").name, "Spread 1")
        self.assertEqual(indesign.activeDocument.get_spread("Spread 1").page_names, ["1", "2"])
        page = indesign.activeDocument.get_page("1")
        self.assertIs(page.select(), page)
        self.assertEqual(indesign.selected_text.contents, "selected")
        self.assertEqual(indesign.selected_text.parent_story_id, 61)
        self.assertEqual(indesign.selected_text.index, 3)
        self.assertEqual(indesign.selected_text.length, 8)
        self.assertTrue(indesign.selected_text.is_valid)
        self.assertEqual(indesign.selected_text.typename, "Text")
        self.assertEqual(indesign.selectedText.parentStoryName, "Story 1")
        frame = indesign.activeDocument.text_frames[0]
        self.assertEqual(frame.id, 51)
        self.assertEqual(frame.name, "Frame 1")
        self.assertEqual(frame.index, 0)
        self.assertEqual(frame.contents, "Hello")
        self.assertFalse(frame.overflows)
        self.assertEqual(frame.geometricBounds[2], 100)
        self.assertEqual(frame.parentStoryId, 61)
        self.assertEqual(frame.parent_story_name, "Story 1")
        self.assertEqual(frame.parentPageId, 31)
        self.assertEqual(frame.parentPageName, "1")
        self.assertTrue(frame.isValid)
        self.assertEqual(frame.typename, "TextFrame")
        self.assertEqual(frame.story.contents, "Hello story")
        self.assertEqual(indesign.activeDocument.getTextFrame("Frame 1").parent_page_name, "1")
        self.assertEqual(frame.set_contents("World", command_name="Text").contents, "World")
        self.assertEqual(indesign_client.calls[-1]["options"]["commandName"], "Text")
        self.assertEqual(frame.setContents("Again", commandName="Text 2", timeoutMs=5).contents, "Again")
        self.assertEqual(indesign_client.calls[-1]["options"]["timeoutMs"], 5)
        story = indesign.activeDocument.stories[0]
        self.assertEqual(story.id, 61)
        self.assertEqual(story.name, "Story 1")
        self.assertEqual(story.index, 0)
        self.assertEqual(story.contents, "Hello story")
        self.assertEqual(story.length, 11)
        self.assertEqual(story.paragraph_count, 2)
        self.assertTrue(story.isValid)
        self.assertEqual(story.typename, "Story")
        self.assertEqual(indesign.activeDocument.getStory("Story 1").textContainerCount, 1)
        self.assertEqual(story.set_contents("Story snake", command_name="Story snake").contents, "Story snake")
        self.assertEqual(story.setContents("Story", commandName="Story").length, 5)
        self.assertEqual(indesign_client.calls[-1]["options"]["commandName"], "Story")
        paragraph_style = indesign.activeDocument.paragraphStyles[0]
        self.assertEqual(paragraph_style.id, 71)
        self.assertEqual(paragraph_style.name, "Body")
        self.assertEqual(paragraph_style.index, 0)
        self.assertTrue(paragraph_style.isValid)
        self.assertEqual(paragraph_style.typename, "ParagraphStyle")
        self.assertEqual(paragraph_style.appliedFont, "Minion Pro")
        self.assertEqual(paragraph_style.applied_font, "Minion Pro")
        self.assertEqual(paragraph_style.fontStyle, "Regular")
        self.assertEqual(paragraph_style.font_style, "Regular")
        self.assertEqual(paragraph_style.point_size, 10)
        self.assertEqual(paragraph_style.leading, 12)
        self.assertEqual(paragraph_style.tracking, 0)
        self.assertEqual(paragraph_style.justification, "left")
        self.assertEqual(paragraph_style.update({"tracking": 1}, command_name="Paragraph").tracking, 1)
        self.assertEqual(indesign_client.calls[-1]["options"]["commandName"], "Paragraph")
        self.assertEqual(indesign.activeDocument.get_paragraph_style("Body").update(pointSize=12).pointSize, 12)
        with self.assertRaises(AttributeError):
            _ = paragraph_style.missing
        character_style = indesign.activeDocument.character_styles[0]
        self.assertEqual(character_style.id, 81)
        self.assertEqual(character_style.name, "Emphasis")
        self.assertEqual(character_style.index, 0)
        self.assertTrue(character_style.is_valid)
        self.assertEqual(character_style.typename, "CharacterStyle")
        self.assertEqual(character_style.applied_font, "Minion Pro")
        self.assertEqual(character_style.fontStyle, "Italic")
        self.assertEqual(character_style.pointSize, 10)
        self.assertEqual(character_style.leading, 12)
        self.assertEqual(character_style.tracking, 5)
        self.assertEqual(indesign.activeDocument.getCharacterStyle("Emphasis").update({"tracking": 20}).tracking, 20)
        swatch = indesign.activeDocument.swatches[0]
        self.assertEqual(swatch.name, "Brand Blue")
        self.assertEqual(swatch.colorValue, [10, 20, 200])
        self.assertTrue(swatch.isValid)
        self.assertEqual(indesign.activeDocument.getSwatch("Brand Blue").space, "RGB")
        self.assertEqual(indesign.activeDocument.add_color_swatch("Accent", [255, 200, 0], space="RGB", command_name="Color").name, "Accent")
        self.assertEqual(indesign_client.calls[-1]["options"]["commandName"], "Color")
        link = indesign.activeDocument.links[0]
        self.assertEqual(link.filePath, "C:/assets/hero.png")
        self.assertEqual(indesign.activeDocument.get_link("hero.png").link_type, "PNG")
        self.assertEqual(link.update(command_name="Update link").status, "updated")
        self.assertEqual(indesign_client.calls[-1]["options"]["commandName"], "Update link")
        self.assertEqual(link.relink("C:/assets/hero-new.png", command_name="Relink").file_path, "C:/assets/hero-new.png")
        self.assertEqual(indesign.activeDocument.exportFile("PDF_TYPE", "C:/out/demo.pdf", options={"preset": "Press"}, commandName="Export")["options"]["preset"], "Press")
        self.assertEqual(indesign.activeDocument.exports.interactivePdf("C:/out/demo-interactive.pdf", options={"showingOptions": True})["format"], "INTERACTIVE_PDF")
        self.assertTrue(indesign.activeDocument.package.forPrint("C:/out/package", commandName="Package")["ok"])
        premiere_client = CapturingClient()
        premiere = Premiere(client=premiere_client)
        self.assertEqual(premiere.activeProject.name, "cut")
        self.assertEqual(premiere.project.itemCount, 3)
        self.assertEqual(premiere.version, "25.6")
        self.assertEqual(premiere.sequences[0].sequenceId, "sequence-1")
        self.assertEqual(premiere.active_sequence.name, "Main edit")
        self.assertEqual(premiere.project.getSequence("Main edit").duration, 120.0)
        sequence = premiere.project.activeSequence
        self.assertEqual(sequence.videoTracks[0].name, "V1")
        self.assertTrue(sequence.video_tracks[0].isTargeted)
        self.assertEqual(sequence.video_tracks[0].clips[0].mediaPath, "C:/media/shot.mov")
        self.assertEqual(sequence.audioTracks[0].clips[0].name, "dialog.wav")
        self.assertEqual(sequence.selected_clips[0].projectItemId, "item-1")
        self.assertEqual(sequence.markers[0].markerType, "comment")
        self.assertEqual(sequence.create_marker("Review", start=42, command_name="Add marker").name, "Review")
        self.assertEqual(premiere_client.calls[-1]["options"]["commandName"], "Add marker")
        root = premiere.project.root_item
        self.assertTrue(root.isBin)
        self.assertEqual(root.children[0].name, "Dailies")
        media_item = root.children[0].children[0]
        self.assertEqual(media_item.media_path, "C:/media/shot.mov")
        self.assertTrue(media_item.canProxy)
        self.assertFalse(media_item.isOffline)
        self.assertEqual(root.findItemsMatchingMediaPath("shot")[0].typename, "ClipProjectItem")
        self.assertEqual(premiere.project.selected_items[0].name, "shot.mov")
        self.assertEqual(root.create_bin("Plates", command_name="Create Plates").name, "Plates")
        self.assertEqual(premiere_client.calls[-1]["options"]["commandName"], "Create Plates")
        imported = premiere.project.import_files("C:/media/new.mov", target_bin=root, command_name="Import")
        self.assertEqual(imported[0].parentId, "root")
        self.assertEqual(imported[0].mediaPath, "C:/media/new.mov")
        self.assertTrue(premiere.encoder.is_ame_installed)
        self.assertEqual(premiere.encoder.presets[0].format, "H.264")
        self.assertEqual(premiere.encoder.get_export_file_extension(sequence, "C:/presets/h264.epr"), "mp4")
        self.assertEqual(
            premiere.encoder.encode_file(
                "C:/media/source.mov",
                "C:/out/source.mp4",
                preset_path="C:/presets/h264.epr",
                options={"workArea": 0},
                command_name="Encode File",
            ).jobId,
            "job-file",
        )
        self.assertEqual(premiere_client.calls[-1]["args"][0]["workArea"], 0)
        self.assertEqual(premiere_client.calls[-1]["options"]["commandName"], "Encode File")
        self.assertEqual(media_item.encode("C:/out/shot.mp4", preset_path="C:/presets/h264.epr").sourceId, "media-1")
        self.assertEqual(sequence.export("C:/out/main.mp4", preset_path="C:/presets/h264.epr", export_type="QUEUE_TO_AME").exportType, "QUEUE_TO_AME")
        self.assertEqual(sequence.export_frame("C:/out/frame.png", time=42).status, "exported")
        self.assertEqual(premiere.export.exportFrame(sequence, "C:/out/frame2.png", time=43).outputPath, "C:/out/frame2.png")

    def test_legacy_cep_facades(self):
        ae_client = CapturingClient()
        ae = AfterEffects(client=ae_client)
        self.assertEqual(ae.version, "24.4")
        self.assertEqual(ae.activeProject.itemCount, 3)
        self.assertEqual(ae.project.path, "C:/cut")
        self.assertEqual(ae.active_project.name, "cut")
        self.assertEqual(ae.project.name, "cut")
        self.assertEqual(ae.app.activeProject.item_count, 3)
        self.assertEqual(ae.app.activeItem.name, "Main Comp")
        self.assertEqual(ae.app.selectedItems[0].name, "Main Comp")
        self.assertEqual(ae.active_item.name, "Main Comp")
        self.assertEqual(ae.activeItem.typeName, "Composition")
        self.assertEqual(ae.selected_items[0].id, 1)
        self.assertEqual(ae.selectedItems[0].name, "Main Comp")
        self.assertEqual(ae.project.activeItem.name, "Main Comp")
        self.assertEqual(ae.project.selectedItems[0].name, "Main Comp")
        self.assertEqual(ae.project.items[1].parentFolderName, "Plates")
        item = ae.project.items[1]
        self.assertEqual(item.id, 2)
        self.assertEqual(item.index, 2)
        self.assertEqual(item.name, "plate.mov")
        self.assertEqual(item.type_name, "Footage")
        self.assertEqual(item.typeName, "Footage")
        self.assertEqual(item.item_type, "footage")
        self.assertEqual(item.itemType, "footage")
        self.assertEqual(item.parent_folder_id, 3)
        self.assertEqual(item.parentFolderId, 3)
        self.assertEqual(item.parent_folder_name, "Plates")
        self.assertFalse(item.selected)
        self.assertIsNone(item.is_active)
        self.assertIsNone(item.isActive)
        self.assertEqual(item.width, 1920)
        self.assertEqual(item.height, 1080)
        self.assertEqual(item.duration, 12.5)
        self.assertEqual(item.frame_rate, 24)
        self.assertEqual(item.frameRate, 24)
        self.assertTrue(item.has_video)
        self.assertTrue(item.hasVideo)
        self.assertFalse(item.has_audio)
        self.assertFalse(item.hasAudio)
        self.assertEqual(item.file_path, "C:/plates/plate.mov")
        self.assertEqual(item.filePath, "C:/plates/plate.mov")
        self.assertFalse(item.missing_footage)
        self.assertFalse(item.missingFootage)
        self.assertEqual(item.typename, "FootageItem")
        comp = ae.project.compositions[0]
        self.assertEqual(ae.project.compositions[0].width, 1920)
        self.assertEqual(ae.project.compositions[0].numLayers, 3)
        self.assertEqual(comp.id, 1)
        self.assertEqual(comp.index, 1)
        self.assertEqual(comp.name, "Main Comp")
        self.assertEqual(comp.type_name, "Composition")
        self.assertEqual(comp.typeName, "Composition")
        self.assertEqual(comp.item_type, "composition")
        self.assertEqual(comp.itemType, "composition")
        self.assertIsNone(comp.parent_folder_id)
        self.assertIsNone(comp.parentFolderId)
        self.assertIsNone(comp.parent_folder_name)
        self.assertIsNone(comp.parentFolderName)
        self.assertTrue(comp.selected)
        self.assertTrue(comp.is_active)
        self.assertTrue(comp.isActive)
        self.assertEqual(comp.height, 1080)
        self.assertEqual(comp.duration, 12.5)
        self.assertEqual(comp.frame_rate, 24)
        self.assertEqual(comp.frameRate, 24)
        self.assertEqual(comp.num_layers, 3)
        self.assertEqual(comp.numLayers, 3)
        self.assertEqual(comp.work_area_start, 0)
        self.assertEqual(comp.workAreaStart, 0)
        self.assertEqual(comp.work_area_duration, 10)
        self.assertEqual(comp.workAreaDuration, 10)
        self.assertEqual(comp.typename, "CompItem")
        footage = ae.project.footage_items[0]
        self.assertEqual(footage.filePath, "C:/plates/plate.mov")
        self.assertEqual(ae.project.footageItems[0].filePath, "C:/plates/plate.mov")
        self.assertFalse(ae.project.footageItems[0].hasAudio)
        self.assertEqual(footage.id, 2)
        self.assertEqual(footage.index, 2)
        self.assertEqual(footage.name, "plate.mov")
        self.assertEqual(footage.type_name, "Footage")
        self.assertEqual(footage.typeName, "Footage")
        self.assertEqual(footage.item_type, "footage")
        self.assertEqual(footage.itemType, "footage")
        self.assertEqual(footage.parent_folder_id, 3)
        self.assertEqual(footage.parentFolderId, 3)
        self.assertEqual(footage.parent_folder_name, "Plates")
        self.assertEqual(footage.parentFolderName, "Plates")
        self.assertIsNone(footage.isActive)
        self.assertEqual(footage.width, 1920)
        self.assertEqual(footage.height, 1080)
        self.assertEqual(footage.duration, 12.5)
        self.assertEqual(footage.frame_rate, 24)
        self.assertEqual(footage.frameRate, 24)
        self.assertTrue(footage.has_video)
        self.assertTrue(footage.hasVideo)
        self.assertFalse(footage.has_audio)
        self.assertEqual(footage.file_path, "C:/plates/plate.mov")
        self.assertFalse(footage.missing_footage)
        self.assertFalse(footage.missingFootage)
        self.assertEqual(footage.typename, "FootageItem")
        folder = ae.project.folders[0]
        self.assertEqual(folder.itemCount, 1)
        self.assertEqual(folder.id, 3)
        self.assertEqual(folder.index, 3)
        self.assertEqual(folder.name, "Plates")
        self.assertEqual(folder.type_name, "Folder")
        self.assertEqual(folder.typeName, "Folder")
        self.assertEqual(folder.item_type, "folder")
        self.assertEqual(folder.itemType, "folder")
        self.assertIsNone(folder.parent_folder_id)
        self.assertIsNone(folder.parentFolderId)
        self.assertIsNone(folder.parent_folder_name)
        self.assertIsNone(folder.parentFolderName)
        self.assertIsNone(folder.selected)
        self.assertIsNone(folder.is_active)
        self.assertIsNone(folder.isActive)
        self.assertEqual(folder.item_count, 1)
        self.assertEqual(folder.typename, "FolderItem")
        self.assertEqual(ae.project.get_item_by_id(1).typename, "CompItem")
        self.assertEqual(ae.project.getItemById(1).name, "Main Comp")
        self.assertEqual(ae.project.get_items_by_name("Main Comp")[0].id, 1)
        self.assertEqual(ae.project.getItemsByName("Main Comp")[0].typeName, "Composition")
        self.assertEqual(comp.layers[0].name, "Title")
        self.assertEqual(comp.selected_layers[0].name, "Title")
        self.assertEqual(comp.selectedLayers[0].id, 11)
        self.assertEqual(comp.get_layer_by_id(11).typename, "TextLayer")
        self.assertEqual(comp.getLayerById("Title").layerType, "text")
        layer = comp.layers[0]
        self.assertEqual(layer.id, 11)
        self.assertEqual(layer.index, 1)
        self.assertEqual(layer.type_name, "TextLayer")
        self.assertEqual(layer.typeName, "TextLayer")
        self.assertEqual(layer.layer_type, "text")
        self.assertEqual(layer.comp_id, 1)
        self.assertEqual(layer.compId, 1)
        self.assertIsNone(layer.source_id)
        self.assertIsNone(layer.sourceId)
        self.assertIsNone(layer.source_name)
        self.assertIsNone(layer.sourceName)
        self.assertTrue(layer.selected)
        self.assertTrue(layer.enabled)
        self.assertFalse(layer.solo)
        self.assertFalse(layer.locked)
        self.assertFalse(layer.shy)
        self.assertTrue(layer.is_text)
        self.assertTrue(layer.isText)
        self.assertEqual(layer.start_time, 0)
        self.assertEqual(layer.startTime, 0)
        self.assertEqual(layer.in_point, 0)
        self.assertEqual(layer.inPoint, 0)
        self.assertEqual(layer.out_point, 12.5)
        self.assertEqual(layer.outPoint, 12.5)
        self.assertEqual(layer.stretch, 100)
        self.assertEqual(layer.width, 1920)
        self.assertEqual(layer.height, 1080)
        self.assertTrue(layer.has_video)
        self.assertTrue(layer.hasVideo)
        self.assertFalse(layer.has_audio)
        self.assertFalse(layer.hasAudio)
        self.assertEqual(layer.effects[0].name, "Gaussian Blur")
        self.assertEqual(layer.masks[0].name, "Mask 1")
        self.assertEqual(layer.source_text.text, "Hello")
        self.assertEqual(layer.sourceText.fontSize, 48)
        effect = layer.get_effect("Gaussian Blur")
        self.assertEqual(effect.match_name, "ADBE Gaussian Blur 2")
        self.assertEqual(effect.matchName, "ADBE Gaussian Blur 2")
        self.assertTrue(effect.enabled)
        self.assertTrue(effect.active)
        self.assertFalse(effect.selected)
        self.assertEqual(effect.property_count, 2)
        self.assertEqual(effect.propertyCount, 2)
        self.assertEqual(effect.typename, "EffectPropertyGroup")
        self.assertEqual(layer.getEffect("ADBE Gaussian Blur 2").id, "fx-1")
        mask = layer.masks[0]
        self.assertEqual(mask.id, "mask-1")
        self.assertEqual(mask.index, 1)
        self.assertEqual(mask.mask_mode, "add")
        self.assertEqual(mask.maskMode, "add")
        self.assertFalse(mask.inverted)
        self.assertFalse(mask.locked)
        self.assertTrue(mask.roto_bezier)
        self.assertTrue(mask.rotoBezier)
        self.assertEqual(mask.opacity, 100)
        self.assertEqual(mask.feather, [2, 2])
        self.assertEqual(mask.expansion, 0)
        self.assertEqual(mask.typename, "MaskPropertyGroup")
        source_text = layer.source_text
        self.assertEqual(source_text.text, "Hello")
        self.assertEqual(source_text.font, "ArialMT")
        self.assertEqual(source_text.font_size, 48)
        self.assertEqual(source_text.fontSize, 48)
        self.assertEqual(source_text.fill_color, [1, 1, 1])
        self.assertEqual(source_text.fillColor, [1, 1, 1])
        self.assertEqual(source_text.stroke_color, [0, 0, 0])
        self.assertEqual(source_text.strokeColor, [0, 0, 0])
        self.assertEqual(source_text.tracking, 10)
        self.assertEqual(source_text.justification, "center")
        self.assertEqual(source_text.typename, "TextDocument")
        self.assertEqual(layer.set_source_text("World", fontSize=36, command_name="Set Text").text, "World")
        self.assertEqual(ae_client.calls[-1]["options"]["commandName"], "Set Text")
        self.assertEqual(layer.setSourceText("Again", commandName="Set Text 2").fontSize, 48)
        render_queue = ae.project.render_queue
        self.assertEqual(render_queue.num_items, 1)
        self.assertEqual(render_queue.numItems, 1)
        self.assertTrue(render_queue.can_queue_in_ame)
        self.assertTrue(render_queue.can_queue_in_a_m_e)
        self.assertTrue(render_queue.canQueueInAME)
        self.assertTrue(render_queue.canQueueInAme)
        self.assertFalse(render_queue.queue_notify)
        self.assertFalse(render_queue.queueNotify)
        self.assertFalse(render_queue.rendering)
        self.assertEqual(render_queue.typename, "RenderQueue")
        render_item = render_queue.items[0]
        self.assertEqual(render_item.id, "rq-1")
        self.assertEqual(render_item.index, 1)
        self.assertEqual(render_item.comp_id, 1)
        self.assertEqual(render_item.compId, 1)
        self.assertEqual(render_item.comp_name, "Main Comp")
        self.assertEqual(render_item.compName, "Main Comp")
        self.assertEqual(render_item.status, "QUEUED")
        self.assertTrue(render_item.render)
        self.assertEqual(render_item.skip_frames, 0)
        self.assertEqual(render_item.skipFrames, 0)
        self.assertFalse(render_item.queue_item_notify)
        self.assertFalse(render_item.queueItemNotify)
        self.assertEqual(render_item.time_span_start, 0)
        self.assertEqual(render_item.timeSpanStart, 0)
        self.assertEqual(render_item.time_span_duration, 10)
        self.assertEqual(render_item.timeSpanDuration, 10)
        self.assertEqual(render_item.num_output_modules, 1)
        self.assertEqual(render_item.numOutputModules, 1)
        self.assertEqual(render_item.templates, ["Best Settings"])
        self.assertEqual(render_item.settings["Quality"], "Best")
        self.assertEqual(render_queue.get_item_by_index(1).compName, "Main Comp")
        self.assertEqual(render_queue.getItemByIndex(1).status, "QUEUED")
        self.assertEqual(render_queue.item(1).typename, "RenderQueueItem")
        output_module = render_item.output_modules[0]
        self.assertEqual(output_module.item_index, 1)
        self.assertEqual(output_module.itemIndex, 1)
        self.assertEqual(output_module.index, 1)
        self.assertEqual(output_module.name, "Lossless")
        self.assertEqual(output_module.file_path, "C:/renders/Main Comp.mov")
        self.assertEqual(output_module.filePath, "C:/renders/Main Comp.mov")
        self.assertEqual(output_module.output_path, "C:/renders/Main Comp.mov")
        self.assertEqual(output_module.outputPath, "C:/renders/Main Comp.mov")
        self.assertTrue(output_module.include_source_xmp)
        self.assertTrue(output_module.include_source_x_m_p)
        self.assertTrue(output_module.includeSourceXMP)
        self.assertTrue(output_module.includeSourceXmp)
        self.assertEqual(output_module.post_render_action, "NONE")
        self.assertEqual(output_module.postRenderAction, "NONE")
        self.assertEqual(output_module.templates[0], "Lossless")
        self.assertEqual(output_module.settings["Format"], "QuickTime")
        self.assertEqual(output_module.typename, "OutputModule")
        self.assertEqual(render_item.output_module(1).outputPath, "C:/renders/Main Comp.mov")
        self.assertEqual(render_item.outputModule(1).name, "Lossless")
        self.assertEqual(render_queue.queue_selected_compositions(command_name="Queue selected")[0].compName, "Main Comp")
        self.assertEqual(ae_client.calls[-1]["options"]["commandName"], "Queue selected")
        self.assertEqual(render_queue.queueSelectedCompositions(commandName="Queue selected 2")[0].status, "QUEUED")
        self.assertEqual(render_queue.add_composition(comp, output_path="C:/renders/new.mov", Crop=True).compId, 1)
        self.assertEqual(ae_client.calls[-1]["args"][0]["settings"]["Crop"], True)
        self.assertEqual(comp.add_to_render_queue(output_path="C:/renders/comp.mov", command_name="Add comp").compName, "Main Comp")
        self.assertEqual(ae_client.calls[-1]["options"]["commandName"], "Add comp")
        self.assertEqual(comp.addToRenderQueue(outputPath="C:/renders/comp2.mov").compId, 1)
        self.assertEqual(render_item.apply_template("Draft").settings["template"], "Draft")
        self.assertFalse(render_item.set_render(False).render)
        self.assertTrue(render_item.setQueueItemNotify(True).queueItemNotify)
        self.assertTrue(render_queue.set_queue_notify(True).queueNotify)
        self.assertEqual(output_module.apply_template("H.264").name, "H.264")
        self.assertEqual(output_module.set_settings({"Crop": True}, command_name="Output settings").settings["Crop"], True)
        self.assertEqual(ae_client.calls[-1]["options"]["commandName"], "Output settings")
        self.assertEqual(output_module.setOutputPath("C:/renders/updated.mov").outputPath, "C:/renders/updated.mov")
        self.assertEqual(output_module.save_as_template("Review").templates[-1], "Review")
        self.assertFalse(render_queue.queue_in_ame(False).rendering)
        self.assertFalse(render_queue.render(command_name="Render now").rendering)

        illustrator = Illustrator(client=CapturingClient())
        self.assertEqual(illustrator.version, "28.2")
        self.assertEqual(illustrator.activeDocument.name, "demo")
        self.assertEqual(illustrator.active_document.path, "C:/demo")
        doc = illustrator.active_document
        self.assertEqual(doc.artboard_count, 2)
        self.assertEqual(doc.artboardCount, 2)
        self.assertEqual(doc.layer_count, 1)
        self.assertEqual(doc.page_item_count, 4)
        self.assertEqual(doc.path_item_count, 1)
        self.assertEqual(doc.pathItemCount, 1)
        self.assertEqual(doc.compound_path_item_count, 1)
        self.assertEqual(doc.compoundPathItemCount, 1)
        self.assertEqual(doc.placed_item_count, 1)
        self.assertEqual(doc.placedItemCount, 1)
        self.assertEqual(doc.raster_item_count, 1)
        self.assertEqual(doc.rasterItemCount, 1)
        self.assertEqual(doc.selection_count, 3)
        self.assertEqual(doc.typename, "Document")
        self.assertEqual(doc.artboards[0].name, "Artboard 1")
        self.assertEqual(doc.artboards[0].artboard_rect, [0, 500, 500, 0])
        self.assertEqual(doc.artboards[0].artboardRect, [0, 500, 500, 0])
        self.assertEqual(doc.artboards[0].ruler_origin, [0, 0])
        self.assertEqual(doc.artboards[0].rulerOrigin, [0, 0])
        self.assertEqual(doc.artboards[0].ruler_par, 1)
        self.assertEqual(doc.artboards[0].rulerPar, 1)
        self.assertTrue(doc.artboards[0].show_center)
        self.assertTrue(doc.artboards[0].showCenter)
        self.assertFalse(doc.artboards[0].show_cross_hairs)
        self.assertFalse(doc.artboards[0].showCrossHairs)
        self.assertFalse(doc.artboards[0].show_safe_areas)
        self.assertFalse(doc.artboards[0].showSafeAreas)
        self.assertEqual(doc.active_artboard.name, "Artboard 2")
        self.assertEqual(doc.activeArtboard.index, 1)
        self.assertEqual(doc.active_artboard_index, 1)
        self.assertEqual(doc.activeArtboardIndex, 1)
        layer = doc.layers[0]
        self.assertEqual(layer.id, "layer-1")
        self.assertEqual(layer.index, 0)
        self.assertEqual(layer.name, "Artwork")
        self.assertTrue(layer.visible)
        self.assertFalse(layer.locked)
        self.assertTrue(layer.printable)
        self.assertTrue(layer.preview)
        self.assertEqual(layer.opacity, 85)
        self.assertTrue(layer.has_selected_artwork)
        self.assertTrue(layer.hasSelectedArtwork)
        self.assertEqual(layer.parent_name, "demo")
        self.assertEqual(layer.parentName, "demo")
        self.assertEqual(layer.parent_typename, "Document")
        self.assertEqual(layer.parentTypename, "Document")
        self.assertEqual(layer.layer_count, 1)
        self.assertEqual(layer.layerCount, 1)
        self.assertEqual(layer.page_item_count, 2)
        self.assertEqual(layer.pageItemCount, 2)
        self.assertEqual(layer.layers[0].name, "Icons")
        self.assertEqual(layer.page_items[0].name, "Logo")
        self.assertEqual(layer.pageItems[0].typename, "PathItem")
        self.assertEqual(doc.get_layer_by_name("Artwork").pageItemCount, 2)
        self.assertEqual(doc.getLayerByName("Artwork").typename, "Layer")
        page_item = doc.page_items[0]
        self.assertEqual(page_item.id, "item-1")
        self.assertEqual(page_item.index, 0)
        self.assertEqual(page_item.name, "Logo")
        self.assertEqual(page_item.item_type, "PathItem")
        self.assertEqual(page_item.itemType, "PathItem")
        self.assertFalse(page_item.hidden)
        self.assertFalse(page_item.locked)
        self.assertTrue(page_item.selected)
        self.assertTrue(page_item.editable)
        self.assertFalse(page_item.sliced)
        self.assertEqual(page_item.position, [10, 490])
        self.assertEqual(page_item.geometric_bounds, [10, 490, 110, 390])
        self.assertEqual(page_item.geometricBounds, [10, 490, 110, 390])
        self.assertEqual(page_item.visible_bounds, [8, 492, 112, 388])
        self.assertEqual(page_item.visibleBounds, [8, 492, 112, 388])
        self.assertEqual(page_item.control_bounds, [5, 495, 115, 385])
        self.assertEqual(page_item.controlBounds, [5, 495, 115, 385])
        self.assertEqual(page_item.width, 100)
        self.assertEqual(page_item.height, 100)
        self.assertEqual(page_item.opacity, 100)
        self.assertEqual(page_item.parent_name, "Artwork")
        self.assertEqual(page_item.parentName, "Artwork")
        self.assertEqual(page_item.parent_typename, "Layer")
        self.assertEqual(page_item.parentTypename, "Layer")
        self.assertEqual(page_item.layer_name, "Artwork")
        self.assertEqual(page_item.layerName, "Artwork")
        self.assertEqual(page_item.note, "brand")
        self.assertEqual(page_item.url, "https://example.com")
        self.assertEqual(page_item.typename, "PathItem")
        self.assertEqual(doc.selection[0].name, "Logo")
        self.assertEqual(doc.get_page_item_by_name("Logo").typename, "PathItem")
        self.assertEqual(doc.getPageItemByName("Logo").layerName, "Artwork")
        path = doc.path_items[0]
        self.assertEqual(path.name, "Logo Path")
        self.assertEqual(path.item_type, "PathItem")
        self.assertEqual(path.itemType, "PathItem")
        self.assertEqual(path.area, 1024.5)
        self.assertTrue(path.closed)
        self.assertFalse(path.clipping)
        self.assertTrue(path.evenodd)
        self.assertTrue(path.filled)
        self.assertEqual(path.fill_color["typename"], "RGBColor")
        self.assertEqual(path.fillColor["red"], 255)
        self.assertFalse(path.fill_overprint)
        self.assertFalse(path.fillOverprint)
        self.assertTrue(path.stroked)
        self.assertEqual(path.stroke_color["typename"], "CMYKColor")
        self.assertEqual(path.strokeColor["black"], 100)
        self.assertEqual(path.stroke_width, 2)
        self.assertEqual(path.strokeWidth, 2)
        self.assertEqual(path.stroke_cap, "RoundEndCap")
        self.assertEqual(path.strokeCap, "RoundEndCap")
        self.assertEqual(path.stroke_join, "RoundEndJoin")
        self.assertEqual(path.strokeJoin, "RoundEndJoin")
        self.assertEqual(path.stroke_dashes, [4, 2])
        self.assertEqual(path.strokeDashes, [4, 2])
        self.assertEqual(path.stroke_dash_offset, 1)
        self.assertEqual(path.strokeDashOffset, 1)
        self.assertEqual(path.stroke_miter_limit, 10)
        self.assertEqual(path.strokeMiterLimit, 10)
        self.assertFalse(path.stroke_overprint)
        self.assertFalse(path.strokeOverprint)
        self.assertFalse(path.guides)
        self.assertEqual(path.length, 128.5)
        self.assertEqual(path.path_point_count, 4)
        self.assertEqual(path.pathPointCount, 4)
        self.assertEqual(path.selected_path_point_count, 2)
        self.assertEqual(path.selectedPathPointCount, 2)
        self.assertTrue(path.pixel_aligned)
        self.assertTrue(path.pixelAligned)
        self.assertEqual(path.polarity, "Positive")
        self.assertEqual(doc.selected_path_items[0].name, "Logo Path")
        self.assertEqual(doc.selectedPathItems[0].typename, "PathItem")
        self.assertEqual(layer.path_items[0].name, "Logo Path")
        self.assertEqual(layer.pathItems[0].pathPointCount, 4)
        self.assertEqual(doc.get_path_item_by_name("Logo Path").strokeWidth, 2)
        self.assertEqual(doc.getPathItemByName("Logo Path").fillColor["red"], 255)
        with self.assertRaises(NotImplementedError):
            path.set_entire_path([[0, 0], [10, 10]])
        with self.assertRaises(NotImplementedError):
            path.setEntirePath([[0, 0], [10, 10]])
        with self.assertRaises(NotImplementedError):
            path.translate(10, 20)
        compound = doc.compound_path_items[0]
        self.assertEqual(compound.name, "Compound Logo")
        self.assertEqual(compound.path_item_count, 1)
        self.assertEqual(compound.pathItemCount, 1)
        self.assertEqual(compound.path_items[0].name, "Compound Child")
        self.assertEqual(compound.pathItems[0].fillColor["typename"], "GrayColor")
        self.assertEqual(doc.selected_compound_path_items[0].name, "Compound Logo")
        self.assertEqual(doc.selectedCompoundPathItems[0].typename, "CompoundPathItem")
        self.assertEqual(layer.compound_path_items[0].name, "Compound Logo")
        self.assertEqual(layer.compoundPathItems[0].pathItemCount, 1)
        self.assertEqual(doc.get_compound_path_item_by_name("Compound Logo").pathItemCount, 1)
        self.assertEqual(doc.getCompoundPathItemByName("Compound Logo").pathItems[0].name, "Compound Child")
        placed = doc.placed_items[0]
        self.assertEqual(placed.name, "Placed")
        self.assertEqual(placed.file_path, "C:/assets/logo.pdf")
        self.assertEqual(placed.filePath, "C:/assets/logo.pdf")
        self.assertEqual(placed.file_name, "logo.pdf")
        self.assertEqual(placed.fileName, "logo.pdf")
        self.assertEqual(placed.bounding_box, [100, 400, 260, 240])
        self.assertEqual(placed.boundingBox, [100, 400, 260, 240])
        self.assertEqual(placed.matrix["mValueA"], 1)
        self.assertEqual(doc.selected_placed_items, [])
        self.assertEqual(doc.selectedPlacedItems, [])
        self.assertEqual(layer.placed_items[0].name, "Placed")
        self.assertEqual(layer.placedItems[0].fileName, "logo.pdf")
        self.assertEqual(doc.get_placed_item_by_name("Placed").filePath, "C:/assets/logo.pdf")
        self.assertEqual(doc.getPlacedItemByName("Placed").typename, "PlacedItem")
        raster = doc.raster_items[0]
        self.assertEqual(raster.name, "Raster")
        self.assertEqual(raster.file_path, "C:/assets/photo.png")
        self.assertEqual(raster.fileName, "photo.png")
        self.assertFalse(raster.embedded)
        self.assertEqual(raster.bits_per_channel, 8)
        self.assertEqual(raster.bitsPerChannel, 8)
        self.assertEqual(raster.channels, 4)
        self.assertEqual(raster.colorants, ["Cyan", "Magenta", "Yellow", "Black"])
        self.assertFalse(raster.colorized_grayscale)
        self.assertFalse(raster.colorizedGrayscale)
        self.assertEqual(raster.image_color_space, "CMYK")
        self.assertEqual(raster.imageColorSpace, "CMYK")
        self.assertTrue(raster.overprint)
        self.assertEqual(doc.selected_raster_items[0].name, "Raster")
        self.assertEqual(doc.selectedRasterItems[0].typename, "RasterItem")
        self.assertEqual(layer.raster_items[0].name, "Raster")
        self.assertEqual(layer.rasterItems[0].bitsPerChannel, 8)
        self.assertEqual(doc.get_raster_item_by_name("Raster").filePath, "C:/assets/photo.png")
        self.assertEqual(doc.getRasterItemByName("Raster").imageColorSpace, "CMYK")

    def test_raw_session(self):
        client = CapturingClient()
        raw = RawSession("illustrator", client)
        raw.eval_js("1", timeout_ms=1)
        raw.evalJs("1", timeoutMs=2)
        raw.eval_extendscript("1")
        raw.eval_extend_script("1")
        raw.evalExtendScript("1", timeoutMs=3)
        raw.send_sdk_message({"x": 1})
        raw.sendSdkMessage({"x": 2}, timeoutMs=4)
        raw.batch_play([{"_obj": "hide"}])
        raw.batchPlay([{"_obj": "show"}], timeoutMs=5)
        self.assertEqual(client.calls[-1]["method"], "batchPlay")


class AsyncFacadeTests(unittest.IsolatedAsyncioTestCase):
    async def test_async_raw(self):
        client = CapturingClient()
        raw = RawSession("premiere", client)
        self.assertEqual(await raw.eval_js_async("1"), {"method": "evalJs"})
        self.assertEqual(await raw.eval_extendscript_async("1"), {"method": "evalExtendScript"})
        self.assertEqual(await raw.eval_extend_script_async("1"), {"method": "evalExtendScript"})
        self.assertEqual(await raw.send_sdk_message_async({"x": 1}), {"method": "sendSdkMessage"})
        self.assertEqual(await raw.batch_play_async([{"_obj": "hide"}]), {"method": "batchPlay"})


if __name__ == "__main__":
    unittest.main()
