# OpenChat connector delegation preparation

This revision provides an OpenChat-owned test harness and adapter for later
use inside the existing Ideaflow connector. It does not add tools to that
installed connector and must not be deployed as an activation change.

The [integration packet](connector-delegation-integration-packet.md) owns the
endpoint and adapter contract, local harness configuration, consent and scope
requirements, production limitations, protected endpoint exception, activation
and rollback plan, and evidence references. Use that packet for implementation
and review; this component remains preparation, not a live connector.
