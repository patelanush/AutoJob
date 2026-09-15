# Adapter coverage

All adapters are implemented on the shared guarded form services. Fixture-tested
coverage remains broader than the explicitly listed live observations.

| Adapter    | Fixture-tested capability                                                                                                   | Important boundary                                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Greenhouse | Contact, resume, custom factual fields, radios, one-page review                                                             | Custom embeds/React widgets without clear semantics require review                                                              |
| Workday    | Multipage navigation, tenant authentication, explicit-absence account creation, repeated experience, review                 | Tenant variations, split dates, unusual account pages and native-submit Next controls may require human steps                   |
| Ashby      | Hydration wait, contact/resume, semantic toggle/radio/checkbox groups, scored autocomplete and required-fact reconciliation | Superhuman's form variant was live-tested through preparation without submission; other Ashby variants may still require review |
| iCIMS      | Standard forms using shared frame-aware inspection/navigation                                                               | Cross-frame custom authentication/controls and alternate portal variants need validation                                        |
| Oracle     | Multipage form/review plus shared authentication and optional verification                                                  | CandidateExperience site-specific auth/date/consent flows need validation                                                       |
| Generic    | Conservative conventional one-page forms                                                                                    | Multipage navigation is human-controlled unless explicitly supported                                                            |

Further local tests exercise ambiguous login refusal, early MFA vs CAPTCHA,
multiple radio groups, scoped facts, blocked verification redirects, human takeover,
credential screenshot exclusion, and dashboard operations.

Required cover-letter files, assessments, CAPTCHA, MFA and personal certifications
are deliberately manual. Additional variants should be added using private/redacted
observations and local fixtures, without submitting live applications for tests.
