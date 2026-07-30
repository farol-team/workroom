# The desktop client's webview is a different origin from the server.
Rails.application.config.middleware.insert_before 0, Rack::Cors do
  allow do
    origins ENV.fetch("WORKROOM_ALLOWED_ORIGINS", "*").split(",").map(&:strip)
    resource "*", headers: :any, methods: %i[get post patch put delete options head],
                  expose: %w[Authorization]
  end
end
