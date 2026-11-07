# Publishing

`/publish?projectId=<id>` opens the saved-project publication flow. Home, review
and editor entry points use the existing session and departure protections. The
page reads the saved revision and publish permission, asks for confirmation and
offers eligible named viewers. If viewer discovery is unavailable, publication
can still be limited to the publishing account.

The page sends an authenticated publication request and displays the
server-acknowledged visitor URL with a locally generated, labelled QR code and
an accessible link and copy fallback. Visitors must sign in as an account in
the selected audience. An uncertain response retains the same ID,
revision and intent for retry. Revision conflicts, approval requirements and
unavailable assets are presented as failures rather than a successful publication.

The access panel checks a known publication link or ID against the current project.
After publication it is prefilled with the acknowledged ID. A current project
manager can revoke access after confirming that the action cannot be undone. If the
result is uncertain, refresh access before trying again. The server rechecks
authority; knowing a link or ID does not grant management access. This flow does
not list existing publications or change their audience.

The current backend accepts authenticated audiences for eligible projects, including
schema-v2 projects using supported visitor capabilities. Class-assigned projects
require approval of the current saved revision, and required assets must be approved.
Unknown origin, public/unlisted creation and unsupported runtime content remain
unavailable. Access checks and revocation do not change the unresolved public/unlisted
policy. This screen does not establish the complete SCRUM-70 workflow.
