'use strict';

/* global L, proj4 */
// const {
//   isUTM,
//   getProj4String,
// } = require('./utils/utm.js');

var utm = require('./utils/utm.js');

var isUTM = utm.isUTM;
var getProj4String = utm.getProj4String;

var chroma = require('chroma-js');

var GeoRasterLayer = L.GridLayer.extend({

  initialize: function initialize(options) {
    try {

      if (!options.debugLevel) options.debugLevel = 1;
      if (!options.keepBuffer) options.keepBuffer = 25;
      if (!options.resolution) options.resolution = Math.pow(2, 5);
      if (options.updateWhenZooming === undefined) options.updateWhenZooming = false;

      this.debugLevel = options.debugLevel;
      if (this.debugLevel >= 1) console.log('georaster:', options);

      var georaster = options.georaster;
      this.georaster = georaster;
      this.scale = chroma.scale();

      /*
          Unpacking values for use later.
          We do this in order to increase speed.
      */
      this.rasters = georaster.values;
      this.projection = georaster.projection;

      this.initProjector(georaster);
      this.initBounds(georaster);
      options.bounds = this._bounds;
      L.setOptions(this, options);

      /*
          Caching the constant tile size, so we don't recalculate everytime we
          create a new tile
      */
      var tileSize = this.getTileSize();
      this._tileHeight = tileSize.y;
      this._tileWidth = tileSize.x;

      if (georaster.sourceType === 'url' && georaster.numberOfRasters === 1 && !options.pixelValuesToColorFn) {
        // For COG, we can't determine a data min max for color scaling,
        // so pixelValuesToColorFn is required.
        throw 'pixelValuesToColorFn is a required option for single-band rasters initialized via URL';
      }
    } catch (error) {
      console.error('ERROR initializing GeoTIFFLayer', error);
    }
  },

  getRasters: function getRasters(options) {
    var _this = this;

    // const {
    //   tileNwPoint,
    //   heightOfSampleInScreenPixels,
    //   widthOfSampleInScreenPixels,
    //   coords,
    //   numberOfSamplesAcross,
    //   numberOfSamplesDown,
    //   ymax,
    //   xmin,
    // } = options;
    var tileNwPoint = options.tileNwPoint;
    var heightOfSampleInScreenPixels = options.heightOfSampleInScreenPixels;
    var widthOfSampleInScreenPixels = options.widthOfSampleInScreenPixels;
    var coords = options.coords;
    var numberOfSamplesAcross = options.numberOfSamplesAcross;
    var numberOfSamplesDown = options.numberOfSamplesDown;
    var ymax = options.ymax;
    var xmin = options.xmin;
    console.log('starting getRasters with options:', options);
    // called if georaster was constructed from URL and we need to get
    // data separately for each tile
    // aka 'COG mode'

    /*
      This function takes in coordinates in the rendered image tile and
      returns the y and x values in the original raster
    */
    var rasterCoordsForTileCoords = function rasterCoordsForTileCoords(h, w) {

      var xCenterInMapPixels = tileNwPoint.x + (w + 0.5) * widthOfSampleInScreenPixels;
      var yCenterInMapPixels = tileNwPoint.y + (h + 0.5) * heightOfSampleInScreenPixels;

      var mapPoint = L.point(xCenterInMapPixels, yCenterInMapPixels);
      console.log('mapPoint:', mapPoint);

      // const { lat, lng } = this._map.unproject(mapPoint, coords.z);
      var unproject = _this._map.unproject(mapPoint, coords.z);
      var lat = unproject.lat;
      var lng = unproject.lng;

      if (_this.projection === 4326) {
        return {
          y: Math.floor((ymax - lat) / _this._pixelHeight),
          x: Math.floor((lng - xmin) / _this._pixelWidth)
        };
      } else if (_this.projector) {
        /* source raster doesn't use latitude and longitude,
           so need to reproject point from lat/long to projection of raster
        */
        // const [x, y] = this.projector.inverse([lng, lat]);

        var inverse = _this.projector.inverse([lng, lat]);
        var x = inverse.x;
        var y = inverse.y;
        return {
          y: Math.floor((ymax - y) / _this._pixelHeight),
          x: Math.floor((x - xmin) / _this._pixelWidth)
        };
      }
    };

    // careful not to flip min_y/max_y here
    var topLeft = rasterCoordsForTileCoords(0, 0);
    var bottomRight = rasterCoordsForTileCoords(numberOfSamplesDown - 1, numberOfSamplesAcross - 1);

    var getValuesOptions = {
      bottom: bottomRight.y,
      height: numberOfSamplesDown,
      left: topLeft.x,
      right: bottomRight.x,
      top: topLeft.y,
      width: numberOfSamplesAcross
    };
    console.log('getValuesOptions:', getValuesOptions);
    return this.georaster.getValues(getValuesOptions);
  },

  createTile: function createTile(coords, done) {
    var error = void 0;

    // Unpacking values for increased speed
    var georaster = this.georaster;
    // const { pixelHeight,  pixelWidth } = georaster;
    // const { xmin, ymax } = georaster;
    // const { rasters } = this;

    var pixelHeight = georaster.pixelHeight;
    var pixelWidth = georaster.pixelWidth;
    var xmin = georaster.xmin;
    var ymax = georaster.ymax;
    var raster = this.raster;

    // these values are used so we don't try to sample outside of the raster
    var minLng = this._bounds.getWest();
    var maxLng = this._bounds.getEast();
    var maxLat = this._bounds.getNorth();
    var minLat = this._bounds.getSouth();

    /* This tile is the square piece of the Leaflet map that we draw on */
    var tile = L.DomUtil.create('canvas', 'leaflet-tile');
    tile.height = this._tileHeight;
    tile.width = this._tileWidth;
    var context = tile.getContext('2d');

    var bounds = this._tileCoordsToBounds(coords);

    var minLngOfTile = bounds.getWest();
    var maxLngOfTile = bounds.getEast();
    var minLatOfTile = bounds.getSouth();
    var maxLatOfTile = bounds.getNorth();

    var rasterPixelsAcross = void 0,
        rasterPixelsDown = void 0;
    if (this.projection === 4326) {
      // width of the Leaflet tile in number of pixels from original raster
      rasterPixelsAcross = Math.ceil((maxLngOfTile - minLngOfTile) / pixelWidth);
      rasterPixelsDown = Math.ceil((maxLatOfTile - minLatOfTile) / pixelHeight);
    } else if (this.projector) {

      // convert extent of Leaflet tile to projection of the georaster
      var topLeft = this.projector.inverse({ x: minLngOfTile, y: maxLatOfTile });
      var topRight = this.projector.inverse({ x: maxLngOfTile, y: maxLatOfTile });
      var bottomLeft = this.projector.inverse({ x: minLngOfTile, y: minLatOfTile });
      var bottomRight = this.projector.inverse({ x: maxLngOfTile, y: minLatOfTile });

      rasterPixelsAcross = Math.ceil(Math.max(topRight.x - topLeft.x, bottomRight.x - bottomLeft.x) / pixelWidth);
      rasterPixelsDown = Math.ceil(Math.max(topLeft.y - bottomLeft.y, topRight.y - bottomRight.y) / pixelHeight);
    }

    // const { resolution } = this.options;
    var resolution = this.options.resolution;

    // prevent sampling more times than number of pixels to display
    var numberOfSamplesAcross = Math.min(resolution, rasterPixelsAcross);
    var numberOfSamplesDown = Math.min(resolution, rasterPixelsDown);

    // set how large to display each sample in screen pixels
    var heightOfSampleInScreenPixels = this._tileHeight / numberOfSamplesDown;
    var heightOfSampleInScreenPixelsInt = Math.ceil(heightOfSampleInScreenPixels);
    var widthOfSampleInScreenPixels = this._tileWidth / numberOfSamplesAcross;
    var widthOfSampleInScreenPixelsInt = Math.ceil(widthOfSampleInScreenPixels);

    var map = this._map;
    var tileSize = this.getTileSize();

    // this converts tile coordinates (how many tiles down and right)
    // to pixels from left and top of tile pane
    var tileNwPoint = coords.scaleBy(tileSize);

    // render asynchronously so tiles show up as they finish instead of all at once (which blocks the UI)
    setTimeout(function () {
      var _this2 = this;

      var tileRasters = null;
      // if (!rasters) {
      //   throw 'Sorry. Cloud Optimized GeoTIFFs are not yet supported';
      /*
      tileRasters = await this.getRasters({
        tileNwPoint, heightOfSampleInScreenPixels,
        widthOfSampleInScreenPixels, coords, pixelHeight, pixelWidth,
        numberOfSamplesAcross, numberOfSamplesDown, ymax, xmin});
      */
      // }

      var _loop = function _loop(h) {
        var yCenterInMapPixels = tileNwPoint.y + (h + 0.5) * heightOfSampleInScreenPixels;
        var latWestPoint = L.point(tileNwPoint.x, yCenterInMapPixels);
        // const { lat } = map.unproject(latWestPoint, coords.z);
        var unproject = map.unproject(latWestPoint, coords.z);
        var lat = unproject.lat;
        if (lat > minLat && lat < maxLat) {
          (function () {
            var yInTilePixels = Math.round(h * heightOfSampleInScreenPixels);
            var yInRasterPixels = _this2.projection === 4326 ? Math.floor((maxLat - lat) / pixelHeight) : null;

            var _loop2 = function _loop2(w) {
              var latLngPoint = L.point(tileNwPoint.x + (w + 0.5) * widthOfSampleInScreenPixels, yCenterInMapPixels);
              // const { lng } = map.unproject(latLngPoint, coords.z);
              var lng = unproject.lng;
              if (lng > minLng && lng < maxLng) {
                var xInRasterPixels = void 0;
                if (_this2.projection === 4326) {
                  xInRasterPixels = Math.floor((lng - minLng) / pixelWidth);
                } else if (_this2.projector) {
                  var inverted = _this2.projector.inverse({ x: lng, y: lat });
                  var xInSrc = inverted.x;
                  var yInSrc = inverted.y;
                  yInRasterPixels = Math.floor((ymax - yInSrc) / pixelHeight);
                  xInRasterPixels = Math.floor((xInSrc - xmin) / pixelWidth);
                }

                var values = null;
                if (tileRasters) {
                  // get value from array specific to this tile
                  values = tileRasters.map(function (raster) {
                    return raster[h][w];
                  });
                } else {
                  // get value from array with data for entire raster
                  values = rasters.map(function (raster) {
                    return raster[yInRasterPixels][xInRasterPixels];
                  });
                }

                // x-axis coordinate of the starting point of the rectangle representing the raster pixel
                var x = Math.round(w * widthOfSampleInScreenPixels);

                // y-axis coordinate of the starting point of the rectangle representing the raster pixel
                var y = yInTilePixels;

                // how many real screen pixels does a pixel of the sampled raster take up
                var width = widthOfSampleInScreenPixelsInt;
                var height = heightOfSampleInScreenPixelsInt;

                if (_this2.options.customDrawFunction) {
                  console.log("running custom draw");
                  _this2.options.customDrawFunction({ values: values, context: context, x: x, y: y, width: width, height: height });
                } else {
                  var color = _this2.getColor(values);
                  if (color) {
                    context.fillStyle = color;
                    context.fillRect(x, y, width, height);
                  }
                }
              }
            };

            for (var w = 0; w < numberOfSamplesAcross; w++) {
              _loop2(w);
            }
          })();
        }
      };

      for (var h = 0; h < numberOfSamplesDown; h++) {
        _loop(h);
      }

      done(error, tile);
    }, 0);

    // return the tile so it can be rendered on screen
    return tile;
  },

  // method from https://github.com/Leaflet/Leaflet/blob/bb1d94ac7f2716852213dd11563d89855f8d6bb1/src/layer/ImageOverlay.js
  getBounds: function getBounds() {
    return this._bounds;
  },

  getColor: function getColor(values) {
    if (this.options.pixelValuesToColorFn) {
      return this.options.pixelValuesToColorFn(values);
    } else {
      // const { mins, noDataValue, ranges } = this.georaster;
      var mins = this.georaster.mins;
      var noDataValue = this.georaster.noDataValue;
      var ranges = this.georaster.ranges;
      var numberOfValues = values.length;
      var haveDataForAllBands = values.every(function (value) {
        return value !== undefined && value !== noDataValue;
      });
      if (haveDataForAllBands) {
        if (numberOfValues == 1) {
          return this.scale((values[0] - mins[0]) / ranges[0]).hex();
        } else if (numberOfValues === 2) {
          return 'rgb(' + values[0] + ',' + values[1] + ',0)';
        } else if (numberOfValues === 3) {
          return 'rgb(' + values[0] + ',' + values[1] + ',' + values[2] + ')';
        } else if (numberOfValues === 4) {
          return 'rgba(' + values[0] + ',' + values[1] + ',' + values[2] + ',' + values[3] / 255 + ')';
        }
      }
    }
  },

  initBounds: function initBounds(georaster) {
    // const { projection, xmin, xmax, ymin, ymax } = georaster;
    var projection = georaster.projection;
    var xmin = georaster.xmin;
    var xmax = georaster.xmax;
    var ymin = georaster.ymin;
    var ymax = georaster.ymax;
    if (this.debugLevel >= 1) console.log('georaster projection is', projection);
    if (projection === 4326) {
      if (this.debugLevel >= 1) console.log('georaster projection is in 4326');
      var minLatWest = L.latLng(ymin, xmin);
      var maxLatEast = L.latLng(ymax, xmax);
      this._bounds = L.latLngBounds(minLatWest, maxLatEast);
    } else if (isUTM(projection)) {
      if (this.debugLevel >= 1) console.log('georaster projection is UTM');
      var bottomLeft = this.projector.forward({ x: xmin, y: ymin });
      var _minLatWest = L.latLng(bottomLeft.y, bottomLeft.x);
      var topRight = this.projector.forward({ x: xmax, y: ymax });
      var _maxLatEast = L.latLng(topRight.y, topRight.x);
      this._bounds = L.latLngBounds(_minLatWest, _maxLatEast);
    } else {
      throw 'georaster-layer-for-leaflet does not support rasters with the current georaster\'s projection';
    }
  },

  initProjector: function initProjector(georaster) {
    // const { projection } = georaster;
    var projection = georaster.projection;
    if (isUTM(projection)) {
      if (!proj4) {
        throw 'proj4 must be found in the global scope in order to load a raster that uses a UTM projection';
      }
      this.projector = proj4(getProj4String(georaster.projection), 'EPSG:4326');
      if (this.debugLevel >= 1) console.log('projector set');
    }
  }

});

if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
  module.exports = GeoRasterLayer;
}
if (typeof window !== 'undefined') {
  window['GeoRasterLayer'] = GeoRasterLayer;
} else if (typeof self !== 'undefined') {
  self['GeoRasterLayer'] = GeoRasterLayer; // jshint ignore:line
}
