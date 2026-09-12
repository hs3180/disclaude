# Command schedules

Command schedules inherit the managed channel transport environment at each tick:

- `DISCLAUDE_API_BASE_URL` is the service's currently bound REST address, including a dynamic port.
- `DISCLAUDE_API_TOKEN` is supplied only while the managed REST API requires authentication.
- `DISCLAUDE_SCHEDULE_ID`, `DISCLAUDE_SCHEDULE_NAME`, and `DISCLAUDE_CHAT_ID` identify the running task.

Do not hard-code a local REST port or reuse a token captured from an earlier service run. A command that invokes `disclaude channel` can use its inherited environment directly.
