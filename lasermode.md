We need to update our post-processor and setup documentation to resolve a critical GRBL laser mode issue. 

When GRBL has Laser Mode enabled (`$32=1`), it suppresses spindle/PWM output during zero-velocity states (such as `G4` dwell pauses). This prevents the plasma torch relay from energizing during pierce delays.

### Required Updates:

1. **G-Code Header Safety Block:**
   Add explicit safety handling in the generated G-code setup header:
   * Emit `$32=0` at the very beginning of the initialization block (or provide a toggle in the UI Settings panel: "Disable GRBL Laser Mode ($32=0) on start", default: ON).
   * Ensure the header outputs:
     ```gcode
     $32=0
     G21
     G90
     G91.1
     G94
     G17
     ```

2. **UI Tooltip / Machine Setup Guide:**
   * In the app's settings/help panel, add a clear note for users converting diode laser engravers (like Atomstack):
     > "Ensure GRBL Laser Mode is disabled (`$32=0`). When `$32=1`, GRBL suppresses the torch relay output during stationary `G4` pierce dwells."

3. **M3 Command Structure:**
   * Verify that every torch pierce block pairs `M3` with the configured max spindle speed (e.g., `M3 S1000`) before calling `G4 P[dwell]`, ensuring full 5V PWM logic high is held continuously while the torch is stationary.

Please apply these updates and verify the generated output file.