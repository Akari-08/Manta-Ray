# Research, methods and evidence

Reviewed 19 November 2026. [Project overview](README.md) · [Operation and input formats](GUIDE.md)

This file brings together the scientific basis, calculation choices, scholarly sources and validation evidence. The supplied stock videos have no independent plant labels, verified site identity, water chemistry or known ecological condition. They support pipeline testing and image observations; their actual lake health remains undetermined.

## What lake researchers assess

Lake condition includes biology, chemistry, physical habitat and suitability for particular uses. The EPA National Lakes Assessment considers biological integrity, trophic state, recreation and stressors through multiple indicators, including nutrients, chlorophyll, dissolved oxygen and biological communities. A camera and TDS probe provide only part of that evidence. [EPA National Lakes Assessment](https://www.epa.gov/national-aquatic-resource-surveys/what-national-lakes-assessment)

For eutrophication, Quebec's monitoring program combines total phosphorus, chlorophyll a and Secchi transparency; dissolved organic carbon helps explain water color. Littoral aquatic plants provide complementary information. Repeated sampling across seasons and years is necessary to interpret trends. This supports collecting contextual observations rather than assigning one universal health score from appearance. [Quebec monitoring methods](https://www.environnement.gouv.qc.ca/eau/rsvl/methodes-en.htm)

The project's immediate research question is whether moving-camera imagery can measure visible-bottom vegetation cover accurately. Tank quadrats with known artificial cover provide a controlled first reference. Field surveys need representative transects/quadrats, independent plant identification and a documented quality-assurance plan. [EPA, *Volunteer Lake Monitoring: A Methods Manual*, EPA 440/4-91-002, chapters 3–5](https://www.epa.gov/sites/production/files/2015-06/documents/lakevolman.pdf)

## Supported observations

| Observation | Definition | Interpretation |
| --- | --- | --- |
| Candidate green cover | Green-rule pixels / eligible pixels in the selected image region × 100 | Calculated from decoded video pixels. Water color and green objects can trigger it; brown plants can be missed. |
| Vegetation cover | Plant area relative to visible bottom, supported by independent labels | Currently unavailable for the stock clips. Image fraction needs suitable geometry before becoming bottom-area fraction. |
| Usable-view fraction | Samples passing configured quality gates / all sampled views × 100 | Brightness/contrast screening only; it does not prove lakebed visibility or accurate classification. |
| Image diagnostics | Median luma, P90–P10 contrast, dark/clipped fractions and adjacent-pixel gradient | Recording diagnostics, not calibrated turbidity, Secchi depth or chlorophyll. |
| Measured TDS | Time-aligned dissolved-solids estimate with site, method and calibration metadata | Supports contextual monitoring, not identification of individual nutrients, pathogens or oxygen. |
| Simulated TDS | Seeded hypothetical chemistry profile | Demonstration input; no evidence about the filmed water. |
| Aquatic life | Detection, individual counts and identified taxa | Not assessed: no validated organism detector, tracker or classifier is implemented. |

The present detector uses RGB green-excess and saturation rules, not a trained vegetation model. Transparent letterbox pixels are excluded. The operator can declare a bottom region, but that declaration is not independently verified. A rejected image stays missing rather than becoming zero vegetation. Adjacent views may repeat the same patch: a clip median describes sampled views, not lakewide cover or surveyed square meters.

Dissolved ions influence electrical conductivity, but their combined response does not identify phosphorus concentration. [USGS, *Conductivity and Water*](https://www.usgs.gov/water-science-school/science/conductivity-electrical-conductance-and-water) Conductivity depends on temperature and geology; conversion to TDS is empirical. Compare calibrated readings with an appropriate site/depth/season baseline and retain the sensor's conversion convention. The project's lake-baseline screen is an engineering choice requiring local validation; EPA's cited baseline guidance concerns streams. [EPA conductivity monitoring guidance, section 5.9](https://archive.epa.gov/water/archive/web/html/vms59.html)

There is no universal project TDS threshold for a healthy lake. ppm approximates mg/L only for dilute freshwater; retain native units. Camera color and TDS cannot substitute for laboratory nutrients, dissolved oxygen or an actual Secchi measurement. Multispectral retrieval is a future calibration study, not an implemented capability. As an example of calibrated optical retrieval, Fuller et al. fitted regional satellite models against field observations; those relationships do not transfer automatically to underwater stock video. [Fuller, Aichele & Minnerick (2004)](https://doi.org/10.3133/sir20045086)

## Assessment methods

### Carlson Trophic State Index

Carlson's original index describes trophic state using indicators related to algal biomass. It does not certify general ecological condition or safety for every use. [Carlson (1977), *A trophic state index for lakes*, **Limnology and Oceanography 22**(2), 361–369, DOI: 10.4319/lo.1977.22.2.0361](https://aslopubs.onlinelibrary.wiley.com/doi/10.4319/lo.1977.22.2.0361)

The engine uses the published NALMS equations below, with chlorophyll a and total phosphorus in µg/L and Secchi depth in meters:

```text
TSI(CHL) = 9.81 ln(CHL) + 30.6
TSI(TP)  = 14.42 ln(TP) + 4.15
TSI(SD)  = 60 - 14.41 ln(SD)
```

Chlorophyll has priority, then phosphorus, then transparency. Different components remain separate; the engine averages per-sample TSI within the chosen parameter. Application categories are <40 oligotrophic, 40–<50 mesotrophic, 50–<70 eutrophic and ≥70 hypereutrophic. Scores are not clipped to 0–100. Non-algal turbidity, colored water and macrophyte-dominated systems complicate interpretation. [NALMS, *Trophic State Equations*](https://www.nalms.org/secchidipin/monitoring-methods/trophic-state-equations/)

Only positive quantified concentrations/depths are eligible. RGB appearance and TDS are never converted into these inputs. The catalog's 20 µg/L chlorophyll example yields TSI ≈59.99 and is explicitly simulated.

### CCME Water Quality Index

CCME WQI evaluates repeated measurements against objectives chosen for the site and intended water use. Its published calculation is:

```text
F1 = 100 × failing parameters / tested parameters
F2 = 100 × failing tests / all tests
maximum excursion = test / objective - 1
minimum excursion = objective / test - 1
nse = sum(excursions) / all tests
F3 = nse / (0.01 × nse + 0.01)
WQI = 100 - sqrt(F1² + F2² + F3²) / 1.732
```

Passing tests have zero excursion. Published categories are ≥95 excellent, ≥80 good, ≥65 fair, ≥45 marginal, otherwise poor. The 2017 manual recommends 8–20 relevant parameters and cautions against fewer than four parameters and four visits annually; timing, relevance and suitable objectives still matter. The engine reports the earlier count minimum separately from the preferred parameter count and labels limited datasets exploratory. [CCME (2017), *Water Quality Index User's Manual*, equations 1–6 and application guidance](https://ccme.ca/en/res/wqimanualen.pdf)

Implementation choices are explicit: range objectives count a measurement once; a failed zero denominator uses the unbounded-excursion limit F3=100; tiny roundoff excursions outside the final 0–100 range are bounded. Unit/chemical identity must agree with the objective. The current interface accepts nonnegative numeric values only; negative temperatures and censored laboratory strings need an appropriate external workflow. Submitted sampling-period metadata does not filter records or prove annual representativeness.

The reference test reproduces the manual's Devon 1997 example: 103 tests, 10 parameters, four failed tests across two parameters, score approximately 88 (good). This validates the calculation, not the quality of any project lake. The all-passing simulated catalog example is also exploratory.

### Camera and TDS screening

`camera_tds` is a project protocol, not a published lake-health index. It summarizes image quality, candidate-green distribution and source-separated TDS counts/median/range. `monitor`, `review` and `data_gap` describe screening actions, with no numeric health score. A measured departure from a compatible supplied site range prompts investigation; overall lake condition remains insufficient evidence.

The input contract distinguishes measured and simulated values, requires measurement method/sample identity/time, rejects duplicate identities and preserves exclusions. Simulation is excluded by default; explicit opt-in labels the report **SIMULATION SCENARIO**, including mixed inputs. Audit output retains equations, intermediate results, engine version, assumptions, references and a canonical SHA-256 of the complete input envelope. These are software provenance measures; they cannot verify an operator's calibration claims or objective selection.

### Simulated TDS model

The shared generator `smooth_harmonic_tds_v1` uses seeded phases with periods 48, 19 and 7 seconds and weights 0.55, 0.30 and 0.15. Values stay within baseline ± variation, bounded below by zero. Defaults are baseline 150 ppm, variation 10 ppm and seed 42. A timestamp/seed gives the same result regardless of query order; zero variation deliberately gives a constant profile.

Both video processing and assessment use that function, with generated values retained separately in the audit. Explicit generation supersedes old simulated rows and preserves measured readings. The profile provides smooth, reproducible demonstration data. Its parameters have no hydrological or chemical calibration and cannot reveal the stock footage's chemistry.

## Reconstruction research

COLMAP's incremental structure-from-motion pipeline estimates camera geometry and sparse 3D points from matching observations across viewpoints. [Schönberger & Frahm (2016), *Structure-from-Motion Revisited*, CVPR, 4104–4113](https://openaccess.thecvf.com/content_cvpr_2016/html/Schonberger_Structure-From-Motion_Revisited_CVPR_2016_paper.html) The project runs feature extraction, sequential matching, mapping, analysis and PLY export through the [official COLMAP CLI](https://colmap.github.io/cli.html).

Texture, overlapping views and camera translation are capture requirements to investigate. Extraction contrast/gradient proxies cannot verify adequate overlap. Underwater calibration, refraction, moving vegetation and a geometric reference require separate validation. A sparse model has arbitrary scale until a known reference establishes scale; internal reprojection error is not an independent physical-accuracy measurement.

## Validation and research readiness

### Evidence already recorded

Software fixtures cover known green areas, padding/ROI denominators, dark/zero-cover distinction, color-rule failures, mask errors despite equal cover, sensor matching, invalid media, malformed requests, command idempotence and reconstruction failure paths. Assessment tests cover reference equations, unit handling, zero-denominator/range objectives, missing inputs, provenance, simulation exclusions and audit determinism.

The final pre-commit verification on 19 November 2026 passed all 52 Python tests and all 45 dashboard tests in complete suite runs. Integration evidence under `outputs/dashboard-runtime/` includes `integration-checks.json`, `ecological-assessment-checks.json`, `assessment-validation.json` and `usability-fixes-checks.json`. Logs/artifacts are local ignored outputs, not distributed research datasets.

Both supplied clips were processed numerically without playing them or displaying frames. The original ecology verification sampled 19 landscape views and 17 portrait views; masks, PNG encoding, counts and source labels passed integrity checks. These tests establish software behavior, not biological accuracy. The portrait clip's reserved color tags required a recorded BT.709 fallback.

Actual CPU COLMAP 4.2.1 runs used 3 fps, at most 30 frames and maximum dimension 1000:

| Stock clip | Registered views | Sparse points | Observations | Mean track length | Mean reprojection error |
| --- | --- | --- | --- | --- | --- |
| `14396264_1920_1080_60fps.mp4` | 29/29 | 14,273 | 128,643 | 9.013032 | 0.498299 px |
| `16770126_2160_3840_60fps.mp4` | 25/25 | 8,923 | 81,464 | 9.129665 | 0.356076 px |

Saved artifacts are under `outputs/colmap-validation-817db1d1d7634fefb8ce547443db5347/`. Independent checks compared source hashes, native model-analyzer results, binary counts, PLY payload sizes and finite coordinates. Physical scale and accuracy against external reference geometry remain unverified. Download provenance for the [official 4.2.1 release](https://github.com/colmap/colmap/releases/tag/4.2.1) is retained in `.tools/colmap-source.json`; archive SHA-256: `c493d88cb4a43f21afba42cb55bf786e5434a0420e73db0ba1454c5d8b3686ae`.

### Required ecological validation

1. Collect independent plant/background/ambiguous labels or known tank quadrats through the intended camera and housing. Record visible-bottom region, scale, date, depth, position, lighting and calibration.
2. Split by independent scene/transect/session before tuning. Keep correlated neighboring frames in one split. Freeze thresholds before held-out evaluation.
3. Report coverage MAE and signed bias in percentage points, mask precision/recall/IoU, sample count and rejection rate. Missing evidence stays distinct from zero plants. Report performance by independent scene; confidence intervals need grouped sampling rather than treating frames as independent replicates.
4. Include brown plants, green water/objects, blur, darkness, glare, occlusion, non-bottom views and sensor mismatch. Validate calibration separately with reference solutions and held-out concentrations/temperatures.
5. For lakewide cover, use representative spatial sampling and account for repeated/unequal footprints. For condition assessment, add relevant field/laboratory chemistry, oxygen/temperature profiles, taxonomy and an approved site-specific monitoring plan.

```text
cover error = predicted cover % - reference cover %
MAE = mean(abs(cover error)); bias = mean(cover error)
precision = TP / (TP + FP); recall = TP / (TP + FN)
IoU = TP / (TP + FP + FN)
```

The mask evaluator returns null for undefined ratios and hashes the inputs. Equal empty masks have zero cover error. Manifest checks reject declared clip leakage and self-reference but cannot independently establish scene independence. Synthetic fixtures establish arithmetic, while held-out real labels establish performance within their evaluated scope.

This is a research prototype with inspectable calculations. Researchers can examine image observations and calculate published indices from suitable supplied measurements. Field vegetation accuracy, sensor accuracy, representative sampling, aquatic-life measurement, hardware behavior and environmental benefit remain to be demonstrated. Nutrient removal and multispectral analysis are research directions without implemented efficacy claims.

## Engineering references

These official implementation references support the hardware guide; they do not establish wet-operation performance:

- [Freenove WROVER camera pin map](https://github.com/Freenove/Freenove_ESP32_WROVER_Board/blob/main/C/Sketches/Sketch_06.1_CameraWebServer/camera_pins.h): board camera assignment.
- [Espressif MCPWM](https://docs.espressif.com/projects/esp-idf/en/v5.3/esp32/api-reference/peripherals/mcpwm.html): peripheral used for fin pulses independently of camera LEDC.
- [Espressif GPIO restrictions](https://docs.espressif.com/projects/esp-idf/en/v4.4.2/esp32/api-reference/peripherals/gpio.html): reserved, input-only and boot-strapping constraints.
- [Espressif ADC guidance](https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32/schematic-checklist.html#adc): ADC/interface considerations.
- [ESP32 camera SCCB driver](https://github.com/espressif/esp32-camera/blob/master/driver/sccb-ng.c): I2C-controller allocation requiring coordination with the MPU bus.
