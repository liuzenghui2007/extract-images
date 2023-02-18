const fs = require('fs');
const rimraf = require('rimraf');
const { PNG } = require('pngjs');
const pako = require('pako');
const { PDFDocumentFactory, PDFName, PDFRawStream } = require('pdf-lib');

// Load the existing PDF
const [, , originalPdfPath] = process.argv;
const pdfDoc = PDFDocumentFactory.load(fs.readFileSync(originalPdfPath));

// Define some variables we'll use in a moment
const imagesInDoc = [];
let objectIdx = 0;

// (1) Find all the image objects in the PDF
// (2) Extract useful info from them
// (3) Push this info object to `imageInDoc` array
pdfDoc.index.index.forEach((pdfObject, ref) => {
  objectIdx += 1;

  if (!(pdfObject instanceof PDFRawStream)) return;

  const { lookupMaybe } = pdfDoc.index;
  const { dictionary: dict } = pdfObject;

  const smaskRef = dict.getMaybe('SMask');
  const colorSpace = lookupMaybe(dict.getMaybe('ColorSpace'));
  const subtype = lookupMaybe(dict.getMaybe('Subtype'));
  const width = lookupMaybe(dict.getMaybe('Width'));
  const height = lookupMaybe(dict.getMaybe('Height'));
  const name = lookupMaybe(dict.getMaybe('Name'));
  const bitsPerComponent = lookupMaybe(dict.getMaybe('BitsPerComponent'));
  const filter = lookupMaybe(dict.getMaybe('Filter'));

  if (subtype === PDFName.from('Image')) {
    imagesInDoc.push({
      ref,
      smaskRef,
      colorSpace,
      name: name ? name.key : `Object${objectIdx}`,
      width: width.number,
      height: height.number,
      bitsPerComponent: bitsPerComponent.number,
      data: pdfObject.content,
      type: filter === PDFName.from('DCTDecode') ? 'jpg' : 'png',
    });
  }
});

// Find and mark SMasks as alpha layers
imagesInDoc.forEach(image => {
  if (image.type === 'png' && image.smaskRef) {
    const smaskImg = imagesInDoc.find(({ ref }) => ref === image.smaskRef);
    smaskImg.isAlphaLayer = true;
    image.alphaLayer = image;
  }
});

// Create a new page
const page = pdfDoc.createPage([700, 700]);

// Add images to the page
imagesInDoc.forEach(image => {
  page.addImageObject(image.name, image.ref);
});

// Log info about the images we found in the PDF
console.log('===== Images in PDF =====');
imagesInDoc.forEach(image => {
  console.log(
    'Name:',
    image.name,
    '\n  Type:',
    image.type,
    '\n  Color Space:',
    image.colorSpace.toString(),
    '\n  Has Alpha Layer?',
    image.alphaLayer ? true : false,
    '\n  Is Alpha Layer?',
    image.isAlphaLayer || false,
    '\n  Width:',
    image.width,
    '\n  Height:',
    image.height,
    '\n  Bits Per Component:',
    image.bitsPerComponent,
    '\n  Data:',
    `Uint8Array(${image.data.length})`,
    '\n  Ref:',
    image.ref.toString(),
  );
});

const PngColorTypes = {
  Grayscale: 0,
  Rgb: 2,
  GrayscaleAlpha: 4,
  RgbAlpha: 6,
};

const ComponentsPerPixelOfColorType = {
  [PngColorTypes.Rgb]: 3,
  [PngColorTypes.Grayscale]: 1,
  [PngColorTypes.RgbAlpha]: 4,
  [PngColorTypes.GrayscaleAlpha]: 2,
};

const readBitAtOffsetOfByte = (byte, bitOffset) => {
  const bit = (byte >> bitOffset) & 1;
  return bit;
};

const readBitAtOffsetOfArray = (uint8Array, bitOffsetWithinArray) => {
  const byteOffset = Math.floor(bitOffsetWithinArray / 8);
  const byte = uint8Array[uint8Array.length - byteOffset];
  const bitOffsetWithinByte = Math.floor(bitOffsetWithinArray % 8);
  return readBitAtOffsetOfByte(byte, bitOffsetWithinByte);
};

const savePng = image =>
  new Promise((resolve, reject) => {
    const isGrayscale = image.colorSpace === PDFName.from('DeviceGray');
    const colorPixels = pako.inflate(image.data);
    const alphaPixels = image.alphaLayer
      ? pako.inflate(image.alphaLayer.data)
      : undefined;

    // prettier-ignore
    const colorType =
        isGrayscale  && alphaPixels ? PngColorTypes.GrayscaleAlpha
      : !isGrayscale && alphaPixels ? PngColorTypes.RgbAlpha
      : isGrayscale                 ? PngColorTypes.Grayscale
      : PngColorTypes.Rgb;

    const colorByteSize = 1;
    const width = image.width * colorByteSize;
    const height = image.height * colorByteSize;
    const inputHasAlpha = [
      PngColorTypes.RgbAlpha,
      PngColorTypes.GrayscaleAlpha,
    ].includes(colorType);

    const png = new PNG({
      width,
      height,
      colorType,
      inputColorType: colorType,
      inputHasAlpha,
    });

    const componentsPerPixel = ComponentsPerPixelOfColorType[colorType];
    png.data = new Uint8Array(width * height * componentsPerPixel);

    let colorPixelIdx = 0;
    let pixelIdx = 0;

    // prettier-ignore
    while (pixelIdx < png.data.length) {
      if (colorType === PngColorTypes.Rgb) {
        png.data[pixelIdx++] = colorPixels[colorPixelIdx++];
        png.data[pixelIdx++] = colorPixels[colorPixelIdx++];
        png.data[pixelIdx++] = colorPixels[colorPixelIdx++];
      } 
      else if (colorType === PngColorTypes.RgbAlpha) {
        png.data[pixelIdx++] = colorPixels[colorPixelIdx++];
        png.data[pixelIdx++] = colorPixels[colorPixelIdx++];
        png.data[pixelIdx++] = colorPixels[colorPixelIdx++];
        png.data[pixelIdx++] = alphaPixels[colorPixelIdx - 1];
      } 
      else if (colorType === PngColorTypes.Grayscale) {
        const bit = readBitAtOffsetOfArray(colorPixels, colorPixelIdx++) === 0 
          ? 0x00 
          : 0xff;
        png.data[png.data.length - (pixelIdx++)] = bit
      } 
      else if (colorType === PngColorTypes.GrayscaleAlpha) {
        const bit = readBitAtOffsetOfArray(colorPixels, colorPixelIdx++) === 0 
          ? 0x00 
          : 0xff;
        png.data[png.data.length - (pixelIdx++)] = bit
        png.data[png.data.length - (pixelIdx++)] = alphaPixels[colorPixelIdx - 1];
      } 
      else {
        throw new Error(`Unknown colorType=${colorType}`);
      }
    }

    const buffer = [];
    png
      .pack()
      .on('data', data => buffer.push(...data))
      .on('end', () => resolve(Buffer.from(buffer)))
      .on('error', err => reject(err));
  });

rimraf('./images/*.{jpg,png}', async err => {
  if (err) console.error(err);
  else {
    let idx = 0;
    for (const img of imagesInDoc) {
      if (!img.isAlphaLayer) {
        const imageData = img.type === 'jpg' ? img.data : await savePng(img);
        fs.writeFileSync(`./images/out${idx + 1}.png`, imageData);
        idx += 1;
      }
    }
    console.log();
    console.log('Images written to ./images');
  }
});
