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

The current backend accepts authenticated audiences and approved schema-v1 class
drafts. Unknown origin, public/unlisted creation and unsupported runtime content
remain unavailable. This screen does not establish the complete SCRUM-70 workflow.
