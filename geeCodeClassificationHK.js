
// STEP 1 - Get a map center and add AOI
//Map.setCenter(37.5, -3,8);
Map.setCenter(114.150950, 22.400795, 8);
Map.addLayer (aoi, {}, 'Hong Kong');


//STEP 2 - Crop and Select the images

// Funtion to clip the map (landsat archive) using Hong Kong Asset as clipping object
var clipToCol = function(image){ 
  return image.clip(aoi);
};

function maskL8sr(image) {
  // Bits 3 and 5 are cloud shadow and cloud, respectively.
  var cloudShadowBitMask = (1 << 3);
  var cloudsBitMask = (1 << 5);
  // Get the pixel QA band.
  var qa = image.select('QA_PIXEL');
  // Both flags should be set to zero, indicating clear conditions.
  var mask = qa.bitwiseAnd(cloudShadowBitMask).eq(0)
                 .and(qa.bitwiseAnd(cloudsBitMask).eq(0));
  return image.updateMask(mask);
}

var img_landsat_8 = ee.ImageCollection(surfaceReflectanceL8.filterDate('2021-01-01', '2021-12-30').map(clipToCol).median()); 
print('this is land 8', img_landsat_8);
//Map.addLayer (img_landsat_8, {}, 'landsat 8 2021');

var truecolor = {
  bands: ["SR_B4","SR_B3","SR_B2"],
  max: 12000,
  min: 3000};

Map.addLayer (img_landsat_8, truecolor, 'landsat 8 2021');

// list with l8 bands
var LS8_bands = ['SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B6', 'SR_B7', 'ST_B10'];//, 'B11'];


// ******** Include indices
//*********** Produce some indices to add in the spectral separability comparison
// make the training image
var TrainingImage = ee.Image(1)
      .addBands(img_landsat_8.median().select(LS8_bands).float())
      .clip(aoi);

// STEP 3 - add a VIs as layers

// Normalized Difference Vegeattion Index
// NDVI = '(nir - red) / (nir + red)'
var bands_4_5 = ['SR_B5','SR_B4'];
var ndvi = TrainingImage.normalizedDifference(bands_4_5).rename('ndvi');
Map.addLayer(ndvi, {}, 'NDVI');

// Normalized Difference Moisture Index

var ndmi = TrainingImage.expression('(nir - swir) / (nir + swir)', {
  'nir' : TrainingImage.select('SR_B5'),
  'swir': TrainingImage.select('SR_B6'),
}).rename('ndmi');
//Map.addLayer(ndmi, {}, 'NDMI');

// Normalized Difference Water Index 

var ndwi = TrainingImage.expression ('(green - nir)/(green + nir)',{
  'green': TrainingImage.select('SR_B3'),
  'nir': TrainingImage.select('SR_B5'),
}).rename('ndwi');
//Map.addLayer(ndwi, {}, 'NDWI');

// Bare soil Index (BSI)
var bsi = TrainingImage.expression ('((red + swir)-(nir+blue))/((red + swir)+(nir+blue))', {
  'red': TrainingImage.select('SR_B4'),
  'swir': TrainingImage.select('SR_B6'),
  'nir': TrainingImage.select('SR_B5'),
  'blue': TrainingImage.select('SR_B2'),
}).rename('bsi');

//Map.addLayer(bsi, {}, 'BSI');

// Shadow Index
var si = TrainingImage.expression('(10000 - red)*(10000 - green)*(10000-blue)', {
  'red': TrainingImage.select('SR_B4'),
  'blue': TrainingImage.select('SR_B2'),
  'green': TrainingImage.select('SR_B3'),
}).pow(1/3).rename('si');

//Map.addLayer(si, {}, 'SI');


// rescaling the indices
var image_2021 = img_landsat_8.reduce(ee.Reducer.median());
print('image 2021 reduced', image_2021);
var landsat_8_rescale = image_2021
  .select(['SR_B2_median', 'SR_B3_median', 'SR_B4_median', 'SR_B5_median', 'SR_B6_median', 'SR_B7_median'])
  .unitScale(0,65535);
var b10_rescale = image_2021
  .select(['ST_B10_median'])
  .unitScale(-32768, 32767);
var ndvi = ndvi.unitScale(-1,1);
var ndmi = ndmi.unitScale(-1,1);
var ndwi = ndwi.unitScale(-1,1);
var bsi = bsi.unitScale (-1,1);
var landsat_8_new = landsat_8_rescale.addBands(b10_rescale).addBands(ndvi).addBands(ndmi).addBands(ndwi).addBands(bsi);


// run classification with 9 classes
// set the selection bands
var TrainingImage = ee.Image(1)
        .addBands(landsat_8_new);
//var TrainingImage = TrainingImage.addBands(ndvi).addBands(ndmi).addBands(ndwi).addBands(bsi).addBands(si); 
var predictionBands = TrainingImage.bandNames();
// sample the regions
var classifierTraining = TrainingImage.select(predictionBands).sampleRegions({collection: classes_9, properties: ['class'], scale: 30 });
// train the classifier
var classifier = ee.Classifier.smileRandomForest(4)
.train({features:classifierTraining, classProperty:'class', inputProperties: predictionBands});
// get the classified image
var img_wat = TrainingImage.select(predictionBands).classify(classifier);

Map.addLayer(img_wat, {min: 1, max: 9,
palette: ['E60909' //1
,'AC7C52' //2
,'326332' //3
, 'E8C933' //4
, 'D0D0D0' //5
, '81C56C' //6
, '6DE448' //7
, 'B4F5A0' // 8
, '1C48C3']}, //9
'classified 9 classes ind');


// ******************** Accuracy assessment 
var sample_rc = classifierTraining.randomColumn('rand');
var training = sample_rc.filter(ee.Filter.lt('rand', 0.7));
var validation = sample_rc.filter(ee.Filter.gte('rand', 0.7));
//print('trianing', training.limit(500));
var classifier = ee.Classifier.smileRandomForest(4)
.train({features:training, classProperty:'class', inputProperties: predictionBands});
var confusionMatrix = ee.ConfusionMatrix(validation.classify(classifier).errorMatrix({actual:'class',  predicted: 'classification'}));
var exportMatrix = ee.Feature(null, {matrix: confusionMatrix.array()});


print ('Confusion Matrix 9  ', confusionMatrix);
print ('Overall Accuracy 9  ', confusionMatrix.accuracy());

// Export the FeatureCollection.
Export.table.toDrive({
  collection: ee.FeatureCollection(exportMatrix),
  description: 'final_9_classes_2021_1403',
  fileFormat: 'CSV'
});

//**********  run the classification algorithm again but now tih the additional indices RESCALED
// set the selection bands
var TrainingImage = ee.Image(1)
        .addBands(landsat_8_new);
//var TrainingImage = TrainingImage.addBands(ndvi).addBands(ndmi).addBands(ndwi).addBands(bsi).addBands(si); 
var predictionBands = TrainingImage.bandNames();
// sample the regions
var classifierTraining = TrainingImage.select(predictionBands).sampleRegions({collection: classes_8_ag, properties: ['class'], scale: 30 });
// train the classifier
var classifier = ee.Classifier.smileRandomForest(4)
.train({features:classifierTraining, classProperty:'class', inputProperties: predictionBands});
// get the classified image
var classified_ind = TrainingImage.select(predictionBands).classify(classifier);

Map.addLayer(classified_ind, {min: 1, max: 8,
palette: ['E60909' //1
,'AC7C52' //2
,'326332' //3
, 'E8C933' //4
, 'D0D0D0' //5
, '81C56C' //6
, '6DE448' //7
, 'B4F5A0']}, // 8
//, '1C48C3']}, //9
'classified 8 classes rescale');


// ******************** Accuracy assessment 
var sample_rc = classifierTraining.randomColumn('rand');
var training = sample_rc.filter(ee.Filter.lt('rand', 0.7));
var validation = sample_rc.filter(ee.Filter.gte('rand', 0.7));
var classifier = ee.Classifier.smileRandomForest(4)
.train({features:training, classProperty:'class', inputProperties: predictionBands});
var confusionMatrix = ee.ConfusionMatrix(validation.classify(classifier).errorMatrix({actual:'class',  predicted: 'classification'}));
var exportMatrix = ee.Feature(null, {matrix: confusionMatrix.array()});


print ('Confusion Matrix 8 ind  ', confusionMatrix);
print ('Overall Accuracy 8 ind  ', confusionMatrix.accuracy());
//*************************
// Export the FeatureCollection. - just for agriculture class
Export.table.toDrive({
  collection: ee.FeatureCollection(exportMatrix),
  description: 'final_8_classes_ag_2021_1403',
  fileFormat: 'CSV'
});


//*********** Use global water surface (water_layer), where the layer "occurence" 
//           indicates where to classify as water, and layer "change_abs" accounts
//           for water surface loss 

var water_layer = ee.Image(global_water).clip(aoi).select('occurrence');
var water_change= ee.Image(global_water).clip(aoi).select('change_abs');

var classified_ind = classified_ind.int8();
var test_img = classified_ind.where(water_layer.gt(0).and(water_change.gt(-50)),9);

Map.addLayer(test_img, {min: 1, max: 9,
palette: ['E60909' //1
,'AC7C52' //2
,'326332' //3
, 'E8C933' //4
, 'D0D0D0' //5
, '81C56C' //6
, '6DE448' //7
, 'B4F5A0' // 8
, '1C48C3']}, //9
'classified 9 classes global water');
// ******************************* Done

// Add reservoirs as a class
var test_img = test_img.where(reservoir_tiff.eq(7),10);
Map.addLayer(test_img, {min: 1, max: 10,
palette: ['E60909' //1
,'AC7C52' //2
,'326332' //3
, 'E8C933' //4
, 'D0D0D0' //5
, '81C56C' //6
, '6DE448' //7
, 'B4F5A0' // 8
, '1C48C3'//9
,'E8E833']}, //10
'classified 10 classes (reservoir)');


//*************** Update classes to remove mangrove above 10m, and remove forests below 10m
//*************** on latest classification (9 classes)

// first select dtm
var dtm_30_sel = dtm_30.map(clipToCol).select('DSM');
var proj = dtm_30_sel.first().select(0).projection();
var dtm_30_sel = dtm_30.map(clipToCol).select('DSM').mosaic().setDefaultProjection(proj);

// reclassify pixels according to height threshold
var classified_dtm_lt_5 = test_img.updateMask(dtm_30_sel.lte(10));
var image_update_1 = test_img.where(classified_dtm_lt_5.eq(6),3);
var image_update_1 = image_update_1.where(classified_dtm_lt_5.eq(7),3);
var image_update_1 = image_update_1.where(classified_dtm_lt_5.eq(8),3);
var classified_dtm_gt_5 = test_img.updateMask(dtm_30_sel.gt(10));
var image_update_1 = image_update_1.where(classified_dtm_gt_5.eq(3),7);
var image_update_2 = image_update_1.where(classified_dtm_gt_5.eq(2),7)
var image_update_2 = image_update_2.where(classified_dtm_gt_5.eq(4),7);


Map.addLayer(image_update_2, {min: 1, max: 10,
palette: ['E60909' //1
,'AC7C52' //2
,'326332' //3
, 'E8C933' //4
, 'D0D0D0' //5
, '81C56C' //6
, '6DE448' //7
, 'B4F5A0' // 8
, '1C48C3' // 9
,'E8E833']}, //10
'classified 10 classes global water reclass');

//*******************

// use water ponds in the end var = test_wat
// replace in image_update_1(where pond==1)=test_wat
//var image_update_2 = image_update_2.where(pond_tiff.eq(1),img_wat);

//add tidal pond as a class
var image_update_2 = image_update_2.where(tidal_pond.eq(1), 11);

//******************* Export results
/*
Export.image.toDrive({
  image: image_update_2,
  description: 'final_class_9_2021_gw_water_ag_1403_v3',
  scale: 30,
  region: aoi
});

// Export the FeatureCollection.
Export.table.toDrive({
  collection: ee.FeatureCollection(exportMatrix),
  description: 'cm_9_classes_2021_gw_ag_vfinal1403_v3',
  fileFormat: 'CSV'
});


// check global water layers
var water_layer = ee.Image(global_water).clip(aoi).select('occurrence');
var water_change= ee.Image(global_water).clip(aoi).select('change_abs');

Map.addLayer(water_layer, {}, 'occurrence GWS');
Map.addLayer(water_change, {}, 'water change layer');

Export.image.toDrive({
  image: water_layer,
  description: 'water_occurence_layer',
  scale: 30,
  region: aoi
});
*/






