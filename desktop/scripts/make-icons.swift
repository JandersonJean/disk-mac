import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let root = URL(fileURLWithPath: #filePath)
  .deletingLastPathComponent()
  .deletingLastPathComponent()

func rgba(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat, _ alpha: CGFloat = 1) -> CGColor {
  CGColor(red: red, green: green, blue: blue, alpha: alpha)
}

func makeContext(width: Int, height: Int, scale: CGFloat = 1) -> CGContext {
  let context = CGContext(
    data: nil,
    width: width,
    height: height,
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  )!
  context.scaleBy(x: scale, y: scale)
  return context
}

func writePNG(_ context: CGContext, to url: URL, width: Int? = nil, height: Int? = nil) throws {
  guard let sourceImage = context.makeImage() else {
    throw NSError(domain: "DiskMacIcons", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not render image at \(url.path)"])
  }
  let outputWidth = width ?? sourceImage.width
  let outputHeight = height ?? sourceImage.height
  var image = sourceImage
  if outputWidth != sourceImage.width || outputHeight != sourceImage.height {
    let output = CGContext(
      data: nil,
      width: outputWidth,
      height: outputHeight,
      bitsPerComponent: 8,
      bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )!
    output.interpolationQuality = .high
    output.draw(sourceImage, in: CGRect(x: 0, y: 0, width: outputWidth, height: outputHeight))
    guard let resized = output.makeImage() else {
      throw NSError(domain: "DiskMacIcons", code: 2, userInfo: [NSLocalizedDescriptionKey: "Could not resize image at \(url.path)"])
    }
    image = resized
  }
  guard
        let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
    throw NSError(domain: "DiskMacIcons", code: 3, userInfo: [NSLocalizedDescriptionKey: "Could not create PNG at \(url.path)"])
  }
  CGImageDestinationAddImage(destination, image, nil)
  guard CGImageDestinationFinalize(destination) else {
    throw NSError(domain: "DiskMacIcons", code: 4, userInfo: [NSLocalizedDescriptionKey: "Could not write PNG at \(url.path)"])
  }
}

func squirclePath(in rect: CGRect, exponent: CGFloat = 5, steps: Int = 720) -> CGPath {
  let path = CGMutablePath()
  let center = CGPoint(x: rect.midX, y: rect.midY)
  let radius = rect.width / 2
  for index in 0...steps {
    let angle = 2 * CGFloat.pi * CGFloat(index) / CGFloat(steps)
    let cosine = cos(angle)
    let sine = sin(angle)
    let x = center.x + radius * (cosine < 0 ? -1 : 1) * pow(abs(cosine), 2 / exponent)
    let y = center.y + radius * (sine < 0 ? -1 : 1) * pow(abs(sine), 2 / exponent)
    let point = CGPoint(x: x, y: y)
    if index == 0 { path.move(to: point) } else { path.addLine(to: point) }
  }
  path.closeSubpath()
  return path
}

func drawGradient(_ context: CGContext, rect: CGRect, top: CGColor, bottom: CGColor) {
  let colors = [top, bottom] as CFArray
  let locations: [CGFloat] = [0, 1]
  let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: locations)!
  context.drawLinearGradient(gradient, start: CGPoint(x: rect.midX, y: rect.maxY), end: CGPoint(x: rect.midX, y: rect.minY), options: [])
}

func drawRing(_ context: CGContext, center: CGPoint, radius: CGFloat, width: CGFloat, opening: Bool) {
  context.setStrokeColor(rgba(0.90, 0.92, 0.94))
  context.setLineWidth(width)
  context.setLineCap(.round)
  if opening {
    let gapCenter = CGFloat.pi / 4
    let halfGap = CGFloat.pi / 24
    context.beginPath()
    context.addArc(center: center, radius: radius, startAngle: gapCenter + halfGap, endAngle: gapCenter - halfGap + 2 * .pi, clockwise: false)
    context.strokePath()
  } else {
    context.strokeEllipse(in: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
  }
}

func drawDiskMark(_ context: CGContext, center: CGPoint, extent: CGFloat, compact: Bool = false) {
  let unit = extent / 824
  let outer = 260 * unit
  let middle = 180 * unit
  let inner = 102 * unit
  let outerStroke = max(12 * unit, compact ? 1.9 : 0)
  let middleStroke = max(10 * unit, compact ? 1.75 : 0)
  let innerStroke = max(9 * unit, compact ? 1.6 : 0)

  drawRing(context, center: center, radius: outer, width: outerStroke, opening: true)
  drawRing(context, center: center, radius: middle, width: middleStroke, opening: true)
  drawRing(context, center: center, radius: inner, width: innerStroke, opening: false)

  context.setStrokeColor(rgba(0.90, 0.92, 0.94))
  context.setLineWidth(max(6 * unit, compact ? 1.35 : 0))
  context.setLineCap(.round)
  let angle = CGFloat.pi / 4
  let start = CGPoint(x: center.x + cos(angle) * (middle + 8 * unit), y: center.y + sin(angle) * (middle + 8 * unit))
  let end = CGPoint(x: center.x + cos(angle) * (outer + 30 * unit), y: center.y + sin(angle) * (outer + 30 * unit))
  context.beginPath()
  context.move(to: start)
  context.addLine(to: end)
  context.strokePath()

  context.setFillColor(rgba(0.90, 0.92, 0.94))
  let hub = max(19 * unit, compact ? 1.55 : 0)
  context.fillEllipse(in: CGRect(x: center.x - hub, y: center.y - hub, width: hub * 2, height: hub * 2))
}

func makeAppIcon() throws {
  let pixels = 1024
  let supersample = 4
  let context = makeContext(width: pixels * supersample, height: pixels * supersample, scale: CGFloat(supersample))
  let body = CGRect(x: 100, y: 100, width: 824, height: 824)
  let shape = squirclePath(in: body)

  context.saveGState()
  context.setShadow(offset: CGSize(width: 0, height: -14), blur: 22, color: rgba(0, 0, 0, 0.28))
  context.addPath(shape)
  context.setFillColor(rgba(0, 0, 0, 0.55))
  context.fillPath()
  context.restoreGState()

  context.saveGState()
  context.addPath(shape)
  context.clip()
  drawGradient(context, rect: body, top: rgba(0.22, 0.23, 0.25), bottom: rgba(0.105, 0.115, 0.125))
  context.restoreGState()

  drawDiskMark(context, center: CGPoint(x: 512, y: 512), extent: 824)
  try writePNG(context, to: root.appendingPathComponent("build/icon.png"), width: pixels, height: pixels)
}

func makeMenuBarIcon(scale: Int) throws {
  let logicalSize: CGFloat = 18
  let supersample = 8
  let pixels = Int(logicalSize) * scale * supersample
  let factor = CGFloat(scale * supersample)
  let context = makeContext(width: pixels, height: pixels, scale: factor)
  context.setStrokeColor(rgba(0, 0, 0))
  context.setFillColor(rgba(0, 0, 0))
  context.setLineCap(.round)

  let center = CGPoint(x: logicalSize / 2, y: logicalSize / 2)
  let outer: CGFloat = 6.1
  let middle: CGFloat = 4.15
  let gapCenter = CGFloat.pi / 4
  let halfGap = CGFloat.pi / 14
  context.setLineWidth(1.55)
  for radius in [outer, middle] {
    context.beginPath()
    context.addArc(center: center, radius: radius, startAngle: gapCenter + halfGap, endAngle: gapCenter - halfGap + 2 * .pi, clockwise: false)
    context.strokePath()
  }

  let start = CGPoint(x: center.x + cos(gapCenter) * (middle + 0.4), y: center.y + sin(gapCenter) * (middle + 0.4))
  let end = CGPoint(x: center.x + cos(gapCenter) * (outer + 1.15), y: center.y + sin(gapCenter) * (outer + 1.15))
  context.setLineWidth(0.95)
  context.beginPath()
  context.move(to: start)
  context.addLine(to: end)
  context.strokePath()
  context.fillEllipse(in: CGRect(x: center.x - 0.75, y: center.y - 0.75, width: 1.5, height: 1.5))

  let name = scale == 1 ? "trayTemplate.png" : "trayTemplate@2x.png"
  let outputSize = Int(logicalSize) * scale
  try writePNG(context, to: root.appendingPathComponent("assets/\(name)"), width: outputSize, height: outputSize)
}

func makeLogoFiles() throws {
  let logo = makeContext(width: 64 * 4, height: 64 * 4, scale: 4)
  drawDiskMark(logo, center: CGPoint(x: 32, y: 32), extent: 64 * 1.12, compact: true)
  try writePNG(logo, to: root.appendingPathComponent("src/renderer/logo.png"), width: 64, height: 64)

  let mark = makeContext(width: 1024, height: 1024)
  drawDiskMark(mark, center: CGPoint(x: 512, y: 512), extent: 1024 * 1.1)
  try writePNG(mark, to: root.appendingPathComponent("branding/logo-mark.png"))

  for (name, color) in [("menubar-black.png", rgba(0, 0, 0)), ("menubar-white.png", rgba(1, 1, 1))] {
    let context = makeContext(width: 576, height: 576)
    context.setStrokeColor(color)
    context.setFillColor(color)
    drawDiskMark(context, center: CGPoint(x: 288, y: 288), extent: 576, compact: true)
    try writePNG(context, to: root.appendingPathComponent("branding/\(name)"))
  }
}

do {
  try FileManager.default.createDirectory(at: root.appendingPathComponent("build"), withIntermediateDirectories: true)
  try FileManager.default.createDirectory(at: root.appendingPathComponent("assets"), withIntermediateDirectories: true)
  try FileManager.default.createDirectory(at: root.appendingPathComponent("branding"), withIntermediateDirectories: true)
  try makeAppIcon()
  try makeMenuBarIcon(scale: 1)
  try makeMenuBarIcon(scale: 2)
  try makeLogoFiles()
  print("Disk Mac icons written")
} catch {
  fputs("Icon generation failed: \(error.localizedDescription)\n", stderr)
  exit(1)
}
