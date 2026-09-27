# Hospital emergency: all technicians busy

This dataset starts **before the user submits the emergency**, so the agents
and approval gate run live. It contains nine technicians, 27 existing jobs,
216 labeled synthetic decision replay rows and 54 simulated notification rows.
The approval queue starts empty. All technicians are on site at 09:00 and
booked again at 13:00 and 16:00. The three refrigerant-certified technicians
also have confirmed Standard-tier appointments at the hospital's dispatch slot.

The app uses real-world time, and this dataset defaults to today's Singapore
date. Its fixed appointment pattern is designed for a presentation near
**09:00 Singapore time**. The app schedules Urgent bookings four hours ahead,
so a booking near 09:00 targets **13:00**;
writing "emergency" does not change the selected delivery tier. This demonstrates
scheduling escalation, not an immediate emergency-response dispatch.

## Run the presentation

1. Refresh the app after loading the data. Open `/admin/schedule` and check
   the current appointments. At other times of day the live booking may follow
   a different path; this fixture does not freeze or override the clock.
2. Open `/admin/flow` in one window and `/book` in another.
3. Enter this booking:

   | Field | Value |
   | --- | --- |
   | Customer | Demo Hospital - Facilities Desk |
   | Email | facilities@example.invalid |
   | Address | Demo Hospital, 5 Lower Kent Ridge Road, Singapore |
   | Map pin | 1.2936, 103.7831 |
   | Category | Not cooling / water leak / strange noise |
   | Tier | **Urgent** |

   Paste this description:

   > Emergency: the hospital ward aircon is not cooling and has a suspected refrigerant leak. The ward temperature is rising and patients are affected. We need an urgent repair today. Please coordinate access with the facilities desk.

4. Submit once and watch `/admin/flow`. Intake identifies the skills, Pricing
   calculates the quote, Capacity warns about workload, and Assignment finds
   **zero free eligible technicians**. Disruption proposes moving an existing
   Standard appointment. The flow pauses at **Awaiting approval**.
5. Open `/admin/approvals`. Review the recommended plan, affected customer,
   replacement time and trade-offs. As the coordinator, simulate agreement
   with the displaced customer and hospital facilities desk, then approve
   with your name. Customer consent is a presenter step, not a recorded consent
   workflow in the app.
6. Show the changed schedule, assigned hospital job, notifications and named
   approval in the decision trail. Only approval permits the reschedule and
   hospital assignment. The app stores notification records; it does not send
   actual email/SMS.

To demonstrate human veto, reload the starting dataset, submit again, and
**Reject**. Existing appointments remain unchanged; the hospital job stays
pending for manual handling. The app does not automatically find an external
contractor or record the repair as complete.

The approval is the existing **Standard** replan gate: changing a confirmed
Standard appointment always needs a human. It is not the separate Emergency
Override gate for a technician becoming unavailable during a frozen appointment.

## Load, repeat and restore

```sh
npm run seed:hospital                 # preview only
npm run hospital:unit                 # offline booking + approve/reject rehearsal
npm run seed:hospital -- --apply      # back up and replace application data
```

Stop other app writers during replacement. The existing recoverable loader
saves every application table to `data-snapshots/before-demo-<timestamp>.json`,
checks the schema before writing, verifies row counts and attempts rollback on
failure. It preserves the current LLM provider configuration. Background data
is synthetic; the user-submitted hospital booking uses that configured provider.
Offline verification uses the deterministic stub, including all three offered
approval options, shift limits, service duration, travel, audit and reject behavior.

The exact sample booking and backup path are saved in
`data-snapshots/hospital-manifest.json`. To restore the previous dataset:

```sh
npm run seed:demo -- --restore data-snapshots/before-demo-<timestamp>.json
```

Rerun `seed:hospital -- --apply` before each presentation. The app's regular Reset
button loads the original small fixture instead. An optional `DEMO_ANCHOR_ISO`
environment variable changes the seed date while keeping the 09:00 clock.
