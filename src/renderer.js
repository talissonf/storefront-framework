'use strict'

const path = require('path')
const paths = require('./lib/paths')
const fs = require('fs')
const ejs = require('ejs')
const ecomUtils = require('@ecomplus/utils')
const ecomClient = require('@ecomplus/client')
const StorefrontRouter = require('@ecomplus/storefront-router')
const EcomSearch = require('@ecomplus/search-engine')
const getStoreData = require('./lib/get-store-data')
const cmsCollections = require('./lib/cms-collections')
const config = require('./lib/config')
const lodash = require('lodash')
const MarkdownIt = require('markdown-it')

const { devMode, storeId, lang, settings } = config

// setup E-Com Plus global config
const { _config } = ecomUtils
;[
  'store_id',
  'lang',
  'currency',
  'currency_symbol',
  'country_code'
].forEach(prop => {
  _config.set(prop, settings[prop])
})

// parse EJS render file async function to promise
const renderFilePromise = (filename, params) => new Promise((resolve, reject) => {
  ejs.renderFile(filename, params, { async: true }, (err, html) => {
    if (err) {
      reject(err)
    } else {
      resolve(html)
    }
  })
})

// precompile EJS templates on production
const templates = {}

const compileTemplate = (filename, prop) => {
  let template
  if (!devMode) {
    try {
      const markup = fs.readFileSync(filename, 'utf8')
      // EJS compile enabling includes and async/await support
      template = ejs.compile(markup, { filename, async: true })
    } catch (err) {
      console.error(err)
    }
  }

  // save render promise to templates object
  templates[prop] = params => new Promise((resolve, reject) => {
    if (!template) {
      // render EJS view directly
      renderFilePromise(filename, params).then(resolve).catch(reject)
    } else {
      try {
        resolve(template(params))
      } catch (err) {
        reject(err)
      }
    }
  })
}

// prepare templates for E-Com Plus store resources
;[
  'products',
  'brands',
  'categories',
  'collections'
].forEach(resource => {
  const filename = path.resolve(paths.pages, `#${resource}.ejs`)
  compileTemplate(filename, resource)
})

// also prepare templates for CMS collections
cmsCollections.forEach(collection => {
  const filename = path.resolve(paths.pages, `#cms/${collection}.ejs`)
  compileTemplate(filename, collection)
})

// setup initial template data
const data = { ...config, lodash, ecomUtils, ecomClient, EcomSearch }

const dataPromise = getStoreData().then(storeData => {
  Object.assign(data, storeData)

  // function to get CMS JSON content
  data.cms = file => {
    // first check if it's a folder collection
    const dirColl = path.join(paths.content, file)
    if (fs.existsSync(dirColl) && fs.lstatSync(dirColl).isDirectory()) {
      // returns list of collection slugs
      return fs.readdirSync(dirColl).map(filename => filename.replace('.json', ''))
    }
    const filepath = `${dirColl}.json`
    if (devMode) {
      let json
      try {
        json = fs.readFileSync(filepath, 'utf8')
      } catch (e) {
        // ignore non existent file
      }
      return json ? JSON.parse(json) : null
    } else {
      return require(filepath)
    }
  }

  // abstraction for dictionary content
  data.dictionary = () => data.cms(`dictionary/${lang}`)

  // markdown parser
  data.md = new MarkdownIt({ html: true })
})

// setup storefront router
const router = new StorefrontRouter(storeId)
const slugRegex = /\/((?!(?:assets|img)(\/|$))[^.]+)(\.(?!js|css|txt|png|gif|jpg|jpeg|webp|svg)[^.]+)*$/

// function to resolve route and get context object
const resolveRoute = route => {
  const { resource, collection, slug } = route
  if (resource) {
    // resolve with storefront router
    return router.resolve(route)
  } else if (collection) {
    return {
      collection,
      slug,
      content: data.cms(`${collection}/${slug}`)
    }
  }
  return {}
}

module.exports = (url, route) => dataPromise

  .then(() => {
    if (route && route.path) {
      return route
    } else if (url === '/') {
      url = '/index'
    } else if (!slugRegex.test(url)) {
      // static file URL
      // must continue serving normally
      return false
    }

    // it is a valid page URL
    // should be prerendered
    try {
      const filename = path.join(paths.pages, `${url}.ejs`)
      if (fs.existsSync(filename)) {
        // predefined view
        return {
          path: url,
          filename
        }
      }
    } catch (e) {
      // ignore error and test CMS collections and store resources
    }

    const [, collection, slug] = url.split('/')
    if (slug && cmsCollections.indexOf(collection) !== -1) {
      // CMS folder collection
      return {
        path: url,
        collection,
        slug
      }
    } else {
      // try to map resource by slug with storefront router
      return router.map(url)
    }
  })

  .then(route => {
    if (route) {
      const { filename, resource, collection } = route
      // setup template parameters
      let context = null
      const params = {
        _: {
          ...data,
          route,
          // abstraction to resolve current rounte
          resolveRoute: () => {
            if (context === null) {
              context = resolveRoute(route)
            }
            return context
          }
        }
      }

      // render EJS template
      if (filename) {
        // do not expose filename
        delete route.filename
        // render page specific EJS file
        return renderFilePromise(filename, params)
      }
      // precompiled template
      return templates[resource || collection](params)
    }
    return route
  })

  .catch(err => {
    const { response } = err
    if (response && response.status < 500) {
      // not a server error
      // route not found ?
      return false
    }
    console.error(err)
    throw err
  })
