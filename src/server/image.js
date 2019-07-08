import Jimp from 'jimp'
import fs from 'fs'
import axios from 'axios'
import tmp from 'tmp'

process.noDeprecation = true

const { name: tmpDir } = tmp.dirSync()

const readFileAsync = path =>
  new Promise((resolve, reject) => {
    fs.readFile(path, (err, data) => {
      if (err) {
        reject(err)
      } else {
        resolve(data)
      }
    })
  })

export default async (req, res) => {
  const [imageUri] = Object.keys(req.query)

  const imageUriSegments = imageUri.split('/')
  const imageId = imageUriSegments[imageUriSegments.length - 1]

  const filePath = `${tmpDir}/${imageId}.jpg`

  const sendBuffer = buffer => {
    res.setHeader('Content-Type', Jimp.MIME_JPEG)
    res.send(buffer)
  }

  try {
    const d = await readFileAsync(filePath)
    sendBuffer(d)
  } catch (e) {
    const img = await axios
      .get(imageUri, {
        responseType: 'arraybuffer',
      })
      .then(({ data }) => Jimp.read(data))
      .then(img =>
        img
          .resize(140, 140)
          .quality(100)
          .write(filePath),
      )

    img.getBuffer(Jimp.MIME_JPEG, (err, buffer) => sendBuffer(buffer))
  }
}
