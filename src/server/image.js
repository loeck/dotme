const axios = require('axios')
const fs = require('fs')
const Jimp = require('jimp')
const tmp = require('tmp')

process.noDeprecation = true

const { name: tmpDir } = tmp.dirSync()

function readFileAsync(path) {
  return new Promise((resolve, reject) => {
    fs.readFile(path, (err, data) => {
      if (err) {
        reject(err)
      } else {
        resolve(data)
      }
    })
  })
}

module.exports = async (req, res) => {
  const [imageUri] = Object.keys(req.query)

  const imageUriSegments = imageUri.split('/')
  const imageId = imageUriSegments[imageUriSegments.length - 1]

  const filePath = `${tmpDir}/${imageId}.jpg`

  const sendBuffer = (buffer) => {
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
      .then((img) => img.resize(70, 70).quality(85).write(filePath))

    img.getBuffer(Jimp.MIME_JPEG, (err, buffer) => sendBuffer(buffer))
  }
}
