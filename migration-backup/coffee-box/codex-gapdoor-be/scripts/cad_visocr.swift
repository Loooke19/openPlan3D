import Foundation
import Vision
import AppKit
import CoreGraphics
import ImageIO

struct Item: Codable {
    let text: String
    let confidence: Float
    let bboxNormXYWH: [Double]
    let bboxPixelXYWH: [Double]
}

struct Result: Codable {
    let image: String
    let width: Int
    let height: Int
    let languagesRequested: [String]
    let languagesSupported: [String]
    let revision: Int
    let items: [Item]
    let joinedText: String
}

func loadCGImage(_ path: String) -> (CGImage, Int, Int)? {
    let url = URL(fileURLWithPath: path)
    if let src = CGImageSourceCreateWithURL(url as CFURL, nil),
       let img = CGImageSourceCreateImageAtIndex(src, 0, nil) {
        return (img, img.width, img.height)
    }
    guard let ns = NSImage(contentsOf: url),
          let tiff = ns.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let cg = rep.cgImage else { return nil }
    return (cg, Int(rep.pixelsWide), Int(rep.pixelsHigh))
}

let args = CommandLine.arguments
guard args.count >= 3 else {
    fputs("usage: visocr <image.png> <out.json>\n", stderr)
    exit(2)
}
let imagePath = args[1]
let outPath = args[2]

guard let (cg, w, h) = loadCGImage(imagePath) else {
    fputs("cannot load \(imagePath)\n", stderr)
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
let langs = ["zh-Hans", "zh-Hant", "en-US"]
request.recognitionLanguages = langs
// Small CAD niche labels (「储藏」 under 理疗室) sit ~12–14pt @300dpi tiles.
request.minimumTextHeight = 0.003
if #available(macOS 13.0, *) {
    request.automaticallyDetectsLanguage = true
}

var supported: [String] = []
if #available(macOS 11.0, *) {
    supported = (try? request.supportedRecognitionLanguages()) ?? []
}

do {
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    try handler.perform([request])
} catch {
    fputs("vision failed: \(error)\n", stderr)
    exit(1)
}

var items: [Item] = []
let observations = request.results ?? []
for obs in observations {
    guard let cand = obs.topCandidates(1).first else { continue }
    let bb = obs.boundingBox
    let px = bb.origin.x * Double(w)
    let py = (1.0 - bb.origin.y - bb.size.height) * Double(h)
    let pw = bb.size.width * Double(w)
    let ph = bb.size.height * Double(h)
    items.append(Item(
        text: cand.string,
        confidence: cand.confidence,
        bboxNormXYWH: [bb.origin.x, bb.origin.y, bb.size.width, bb.size.height],
        bboxPixelXYWH: [px, py, pw, ph]
    ))
}

items.sort { $0.bboxPixelXYWH[1] == $1.bboxPixelXYWH[1]
    ? $0.bboxPixelXYWH[0] < $1.bboxPixelXYWH[0]
    : $0.bboxPixelXYWH[1] < $1.bboxPixelXYWH[1] }

let joined = items.map { $0.text }.joined(separator: "\n")
let result = Result(
    image: imagePath,
    width: w,
    height: h,
    languagesRequested: langs,
    languagesSupported: supported,
    revision: request.revision,
    items: items,
    joinedText: joined
)

let enc = JSONEncoder()
enc.outputFormatting = [.prettyPrinted, .sortedKeys]
enc.nonConformingFloatEncodingStrategy = .convertToString(
    positiveInfinity: "inf", negativeInfinity: "-inf", nan: "nan"
)
try enc.encode(result).write(to: URL(fileURLWithPath: outPath))
FileHandle.standardError.write(Data("ok \(imagePath) items=\(items.count)\n".utf8))
