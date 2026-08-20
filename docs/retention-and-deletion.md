# Retention and deletion policy

This policy applies to the Patient Imaging Portal. The clinic reviews it against its legal and contractual duties before production use; a deletion request never bypasses a required hold.

## Retention periods

| Records | Retention |
| --- | --- |
| Images, cine clips, frames, and reports (preliminary or signed) | Seven years after the related visit. |
| Appointments and appointment transitions | Seven years after the appointment. |
| Identity attempts | 90 days after the attempt. |
| Share links | One year after expiry or revocation. Revocation stops new access grants immediately. |
| Deletion requests | Seven years after the request is completed or declined. |
| Audit events | Seven years after the event. Audit events are append-only and are not deleted by a deletion request. |

The portal does not collect a separate intake record.

## Patient deletion requests

A patient can submit a request from `/profile`. The request records intent only; it does not delete data. A clinic privacy administrator verifies the requester, checks legal holds and retention duties, then deletes or minimizes records whose retention period and obligations allow it. The administrator marks the deletion request completed or declined and contacts the patient. The application role can insert its caller's request but cannot perform deletion.

Deleting eligible patient records does not erase audit events. Share links are revoked, not deleted, so their audit history survives. Images, cine clips, frames, reports, appointments, and appointment transitions remain available while the request is reviewed.

## Access residue

Authorization and audit occur once per PHI access grant. Audit granularity is therefore the access grant, not each downloaded byte or cine frame. A previously issued signed URL can remain usable for `config.signedUrlTtlSeconds`, currently 300 seconds, after a share link is revoked or a deletion request is acted on. New grants stop immediately; the short-lived signed URL expires without renewal.
