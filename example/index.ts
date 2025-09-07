import express from 'express'
import { foo } from './foo'

const app = express()

app.get('/foo', (req, res) => {
  res.json(foo())
  res.end()
})


app.listen(3000, (err) => {
  if (err) {
    console.error('Error starting server:', err)
    return
  } else {
    console.log('Server is running on http://localhost:3000')
  }
})
