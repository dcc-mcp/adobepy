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
            return {"id": 7, "name": "demo", "path": "C:/demo", "width": 100, "height": 50}
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
        if namespace == "raw" and method == "evalJs":
            return {"source": args[0], "args": list(args[1:])}
        if namespace == "raw" and method == "getPath":
            return {"path": list(args[0]), "depth": args[1]}
        if namespace == "raw" and method == "callPath":
            return {"path": list(args[0]), "args": list(args[1]), "depth": args[2]}
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
        self.assertEqual(InDesign(client=CapturingClient()).active_document.name, "demo")
        self.assertEqual(InDesign(client=CapturingClient()).version, "19.5")
        self.assertEqual(Premiere(client=CapturingClient()).activeProject.name, "cut")
        self.assertEqual(Premiere(client=CapturingClient()).project.name, "cut")
        self.assertEqual(Premiere(client=CapturingClient()).version, "25.6")

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
