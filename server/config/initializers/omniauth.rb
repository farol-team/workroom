# Identity comes from the organisation's provider. Nothing here holds a model
# credential (Article P2) — these are the workspace's own secrets.
Rails.application.config.middleware.use OmniAuth::Builder do
  issuer = ENV["OIDC_ISSUER"]

  if issuer.present?
    provider :openid_connect,
             name: :openid_connect,
             scope: %i[openid email profile],
             response_type: :code,
             discovery: true,
             issuer: issuer,
             client_options: {
               identifier: ENV.fetch("OIDC_CLIENT_ID"),
               secret: ENV.fetch("OIDC_CLIENT_SECRET"),
               redirect_uri: ENV.fetch("OIDC_REDIRECT_URI",
                                       "http://127.0.0.1:3000/auth/openid_connect/callback")
             }
  elsif Rails.env.test?
    # OmniAuth's test mode replaces the whole request cycle, so the strategy only
    # has to be in the stack. Without this the callback route is never handled
    # and the tests exercise a middleware that is not there.
    provider :openid_connect,
             name: :openid_connect,
             discovery: false,
             issuer: "https://example.test",
             client_options: { identifier: "test", secret: "test", host: "example.test" }
  end
end

# A failure is a failure. Without this the default handler redirects to a page
# this application does not have, and the client sees a 302 into nothing.
OmniAuth.config.on_failure = proc { |env| SessionsController.action(:failure).call(env) }
