# Clear demo language

Request: review the complete retained hackathon demo and replace confusing copy with what happened, whether it is a problem, and the next action. Explain app policy restrictions.

Scope: main recovery monitor and retained manual activation, cancellation, analytics and fixture lab pages served by the Python demo at port8875. Preserve all existing work, statuses, evidence, approval requirements and behavior. No new integrations or manufactured success. CLI reads the catalog; it cannot supply Lumen application decisions.

Semantics: recovery_domain._gate checks customer mapping, then the app's policies.enabled and premium_export feature rule, then cache and subscription period. A policy restriction is an intentional app-level gate denial; it is not a failed payment or an automatic repair target. Expired access is also a normal denial. Failed independent verification leaves the outcome unconfirmed; a local readback is separate evidence. Historical failed checks may later pass and must be labeled accordingly. Current observations and past incident results are different times.

Implementation split: root owns main monitor UI/API copy and integration; secondary_demo_copy worker owns secondary retained JS views/apps and focused tests. Explorer confirmed copy problems; its suspected /analytics.html route issue was rejected because the server explicitly aliases it to /index.html.

Baseline: Node22.22.3/Python3.13.13; preceding checkpoint passed63 JS,172 Python and14 HTTP integration checks. Widespread pre-existing dirty changes prevent a clean task-only commit. Next: integrate copy, inspect screenshots of primary and secondary flows, run focused/full relevant checks, and record limits.
