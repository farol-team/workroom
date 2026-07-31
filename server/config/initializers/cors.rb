# The desktop client's webview is a different origin from the server.
Rails.application.config.middleware.insert_before 0, Rack::Cors do
  allow do
    # `*` is right for a desktop client on a developer's machine and wrong the
    # moment this is reachable from a browser: a bearer token plus an open
    # origin policy is any page on the internet acting as the person holding it.
    allowed = ENV["WORKROOM_ALLOWED_ORIGINS"].presence

    # Refused at boot, not at build. Precompiling assets loads this environment
    # inside the image, where no origin is set and none can be — Rails marks that
    # case with SECRET_KEY_BASE_DUMMY, and it is the difference between an image
    # that cannot be built and a server that will not start misconfigured.
    if allowed.nil? && Rails.env.production? && ENV["SECRET_KEY_BASE_DUMMY"].blank?
      raise "WORKROOM_ALLOWED_ORIGINS must be set in production"
    end

    origins((allowed || "*").split(",").map(&:strip))
    resource "*", headers: :any, methods: %i[get post patch put delete options head],
                  expose: %w[Authorization]
  end
end
