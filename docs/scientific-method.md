# Scientific basis for the survey measurements

Reviewed 17 November 2026. The ecological output is a measurement record with an explicit evidence status. The two supplied stock clips have no reference vegetation masks, water chemistry, verified sampling location, or known ecological condition. Automated processing can establish decoding and software behavior. Accuracy on those ecosystems remains unmeasured.

## What researchers measure

Lake condition spans biological, chemical, physical, and human-use indicators. The EPA National Lakes Assessment includes chlorophyll a, aquatic organism communities, nitrogen, phosphorus, dissolved oxygen, habitat, cyanobacteria, and bacterial indicators. A camera and a TDS probe provide only part of that evidence. [EPA National Lakes Assessment indicators](https://www.epa.gov/national-aquatic-resource-surveys/what-national-lakes-assessment)

For eutrophication, Quebec's lake-monitoring program uses total phosphorus, chlorophyll a, and Secchi transparency, with dissolved organic carbon to help interpret water color. Littoral plant abundance supplies complementary evidence. Measurements vary among sites and seasons, so the program recommends repeated sampling over two to three years. These methods support a monitoring design that records where and when each observation was taken. [Quebec lake-monitoring methods](https://www.environnement.gouv.qc.ca/eau/rsvl/methodes-en.htm)

The EPA volunteer manual describes plant-bed mapping, transect observations, and professional identification of collected specimens. It treats monitoring as a planned sampling and quality-assurance activity. This motivates the project's visible-bottom coverage objective and comparison against known tank patches. [EPA Volunteer Lake Monitoring methods manual, chapters 3 and 4](https://www.epa.gov/sites/production/files/2015-06/documents/lakevolman.pdf)

## Measurements supported by the present equipment

| Output | Definition and use | Interpretation limits |
| --- | --- | --- |
| Candidate green cover, % | Selected green pixels divided by eligible pixels in an explicitly defined image region, multiplied by 100. Useful for repeatable image screening and classifier development. | Water color and green nonplant objects can trigger the detector. Brown plants can be missed. Ground-truth validation is needed before interpreting it as vegetation cover. |
| Validated vegetation cover, % | Independently verified plant pixels divided by the visible bottom within a reference quadrat or region. Compare the algorithm with that reference. | Image fraction approximates bottom-area fraction only with suitable viewing geometry and a documented sampling footprint. |
| Usable-view fraction, % | Number of samples passing the configured image-quality tests divided by all sampled views. Retain reasons for rejected views. | A view can pass brightness and contrast checks while showing open water, a side view, artificial objects, or the wrong habitat. |
| Image quality diagnostics | Brightness, contrast, and any sharpness or color diagnostics explicitly emitted by the implementation. These describe recording conditions and help identify poor survey data. | Calibrated turbidity in NTU, Secchi depth, and chlorophyll concentration require measurement procedures or calibrated retrieval models. |
| TDS, ppm in the software interface | A measured dissolved-solids estimate with sampling time, location, sensor method, and calibration history. Summarize distribution and compare with a relevant site baseline. For dilute freshwater, ppm is approximately mg/L; retain the sensor's original convention. | A concentration alone does not identify nutrient species, toxicity, pathogens, or oxygen availability. |
| Simulated TDS | An explicitly labeled software input for demonstration and integration testing. | Exclude it from statements about the stock clip's water chemistry and from measured-condition conclusions. |

USGS explains the connection between dissolved ions and electrical conductivity. A low-cost conductivity-derived TDS reading responds to the combined ionic solution. It cannot resolve a phosphorus concentration from that combined response. [USGS conductivity and water](https://www.usgs.gov/water-science-school/science/conductivity-electrical-conductance-and-water)

EPA conductivity guidance describes temperature effects, local geology, calibration against a standard, and an empirically determined conductivity-to-TDS conversion. It also uses established site baselines for change detection in streams. The project's extension to lake TDS comparisons is an engineering choice that needs lake-specific validation. Record the sensor's temperature compensation and conversion convention. Compare matched sites, depths, seasons, methods, and units. [EPA conductivity monitoring guidance](https://archive.epa.gov/water/archive/web/html/vms59.html)

There is no project-wide TDS cutoff for a healthy lake. A site-baseline difference is a change flag for investigation. An unknown location or simulated reading cannot support that comparison. Raw camera color cannot supply the missing nutrient, dissolved-oxygen, or chlorophyll measurements. Overall ecological condition therefore remains undetermined for the supplied footage.

## Sampling and provenance

Each run should retain the input file identity, software version or source revision, parameters, sampling interval, image region, and processing result. Each measurement needs a timestamp relative to the clip, the relevant units, and its origin. Keep sensor readings separate from image-derived estimates and identify simulated inputs in every downstream report.

For a physical survey, record the water body, date, coordinates, depth, camera orientation, height above bottom, lighting, and sensor calibration. Plan repeatable transects or quadrats before collecting footage. Retain a visible-bottom region and exclude the sky, vehicle, people, water column, and opaque obstructions from its denominator. An automatic quality gate cannot establish that the selected region is lakebed.

A sequence of neighboring frames can repeatedly cover the same patch. Treat a clip-level average as a description of sampled views. A lakewide area estimate needs a representative spatial design and a way to account for overlapping footprints. Unequal footprints need area weights. Pixel counts alone cannot determine the number of square meters surveyed.

## Validation protocol

1. Establish ground truth independently. For the tank, photograph known artificial patches through the same camera and housing. Measure their cover within a fixed quadrat. For recorded field images, have an annotator label plant and visible-bottom pixels. Save the original labels and record ambiguous areas as excluded.
2. Split by independent scene, transect, or recording session before tuning. Adjacent frames from one clip belong to the same split. Tune color and quality thresholds using the development split, then freeze them for the held-out evaluation.
3. Report cover mean absolute error in percentage points and signed bias. Report mask precision, recall, and intersection-over-union when pixel labels exist. Also report sample count, rejected-view count, and the evaluation split. An unscorable or rejected view is missing evidence and must stay distinct from a reference with zero plants.
4. Include difficult cases such as green water with no plants, brown plants, motion blur, darkness, glare, low contrast, partial bottom visibility, different aspect ratios, duplicate frames, malformed media, and sensor readings with invalid values or unmatched timestamps.
5. Report performance by scene or recording session. Confidence intervals need independent units or a defensible grouped resampling design. Avoid treating every correlated video frame as an independent ecological replicate.
6. Validate sensors separately using reference solutions and the manufacturer's procedure. Test a held-out concentration and repeated readings across the intended temperature range. Software acceptance of a CSV is distinct from sensor accuracy.

The formulas below define the project evaluation metrics. Their use is an evaluation design choice.

```text
coverage error in percentage points = predicted cover % - reference cover %
MAE = mean(abs(coverage error))
bias = mean(coverage error)
precision = true-positive plant pixels / all predicted plant pixels
recall = true-positive plant pixels / all reference plant pixels
IoU = intersection of predicted and reference plant masks / their union
```

The evaluator returns explicit null values when precision, recall, or IoU has an empty denominator. A pair of empty masks still has zero coverage error. The train/test leakage check uses the manifest's declared clip identifiers, so the dataset author must group independent scenes correctly. Synthetic fixtures test arithmetic and program behavior. Held-out real labels establish performance on footage. Neither supplies missing water chemistry.

## Additional measurements for a future lake assessment

The project's observation layer can later accompany laboratory phosphorus and chlorophyll a, Secchi transparency, calibrated dissolved oxygen and temperature profiles, species identification, and an approved site-specific monitoring plan. Retain those measurements in their native units and methods. Multispectral imaging requires radiometric calibration and field reference measurements before using spectral indices to infer concentration or condition.
