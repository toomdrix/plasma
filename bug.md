
Please update our G-code generation and post-processing module to strictly adhere to the GRBL v1.1 / NIST RS274NGC V3 standard.

### Required Changes:

1. **Modal Initialization Header:**
   At the start of the G-code output, emit each modal command on its own separate line:
   ```gcode
   G21
   G90
   G91.1
   G94
   G17
   ```


* `G91.1` is critical to explicitly set Incremental Arc I/J mode to prevent GRBL Error 33.

2. **Clean Comment Stripping:**
* Remove all inline comments (e.g., replace `G21 (Metric)` with `G21`).
* Never combine executable G-code words and parenthetical `(...)` comments on the same line.
* Informational header comments must reside exclusively on their own standalone lines.


3. **Arc Center ($I, J$) Precision & Incremental Offsets:**
* Ensure all arc moves (`G2`/`G3`) calculate relative vector offsets from the start vertex:
$I = X_{\text{center}} - X_{\text{start}}$
$J = Y_{\text{center}} - Y_{\text{start}}$
* Format all coordinate values ($X, Y, I, J$) rounded strictly to 3 decimal places (`0.001 mm`) to prevent floating-point precision mismatch.


4. **Dwell Formatting:**
* Pierce dwell must be output as `G4 P...` with floating-point seconds (e.g., `G4 P0.3`).


5. **Program Termination:**
* End every file cleanly with:
    ```gcode
    M5
    M2
    ```


Please run unit tests / verification on the updated exporter using our test sample geometry and ensure no line exceeds 128 characters.