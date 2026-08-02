# OpenViking, baked once instead of pip-installed on every container start.
# The version pin lives here and nowhere else — bumping it is a one-line,
# reviewable change (#223).
FROM python:3.12-slim
RUN pip install --no-cache-dir openviking==0.4.11 'mcp<2'
ENTRYPOINT ["openviking-server", "--host", "0.0.0.0", "--port", "1933"]
