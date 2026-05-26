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
            return payload
        if namespace == "document" and method == "getById":
            return {"id": args[0], "name": "demo", "width": 100, "height": 50}
        if namespace == "document" and method in {"getLayers", "getActiveLayers"}:
            return [{"id": 11, "name": "Layer 1", "kind": "pixel", "opacity": 80, "visible": True, "isSmartObject": False}]
        if namespace == "layer":
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

    def test_legacy_cep_facades(self):
        ae = AfterEffects(client=CapturingClient())
        self.assertEqual(ae.version, "24.4")
        self.assertEqual(ae.activeProject.itemCount, 3)
        self.assertEqual(ae.project.path, "C:/cut")

        illustrator = Illustrator(client=CapturingClient())
        self.assertEqual(illustrator.version, "28.2")
        self.assertEqual(illustrator.activeDocument.name, "demo")
        self.assertEqual(illustrator.active_document.path, "C:/demo")

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
