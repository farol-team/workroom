Rails.application.routes.draw do
  get "up" => "rails/health#show", as: :rails_health_check

  # A desktop sign-in starts here so the return address is remembered before the
  # provider is visited; OmniAuth mounts /auth/:provider itself.
  get "auth/openid_connect", to: "sessions#start", as: :start_sign_in

  # OmniAuth mounts /auth/:provider itself; these are where it comes back to.
  get  "auth/:provider/callback", to: "sessions#create"
  post "auth/:provider/callback", to: "sessions#create"
  get  "auth/failure",            to: "sessions#failure"

  # Versioned, because the desktop client is installed on people's machines and
  # updated when they say so (#69) — so old ones exist by design, and a response
  # shape that changes under one of them fails the way #94 describes: the turn
  # completes and the answer is wrong. `/up` is not here; a health check is not
  # an API.
  namespace :api do
    namespace :v1 do
    post "auth", to: "auth#create"
    get  "auth/methods", to: "auth#methods_available", as: :auth_methods
    # A page in a browser asking what its httpOnly cookie carries (#306), and
    # giving it up again.
    get    "auth/session", to: "auth#session", as: :auth_session
    delete "auth/session", to: "auth#destroy_session"
    get  "me", to: "auth#me", as: :me

    # One MCP endpoint per channel — the channel in the url is the scope.
    post "rail/:slug", to: "rail#call", as: :rail

    # The store, one channel wide. No slug: the scope travels in the token, so a
    # url cannot address a room the token does not name.
    post "memory/mcp", to: "memory_gateway#call", as: :memory_gateway

    resources :workspaces, only: %i[index create]
    get "workspace/members", to: "workspaces#members", as: :workspace_members

    # An invitation is how somebody reaches a room they are not in, so it is
    # redeemed from outside the room it lets them into.
    resources :invitations, only: %i[index create]

    # The workspace's agent personas (#233): descriptions only, never a
    # credential. Deleted by name, because the name is the identity.
    resources :agent_definitions, only: %i[index create]
    delete "agent_definitions/:name", to: "agent_definitions#destroy",
           constraints: { name: %r{[^/]+} }, as: :agent_definition
    post "invitations/:code/accept", to: "invitations#accept", as: :accept_invitation

    get "channel-templates", to: "channels#templates", as: :channel_templates
    resources :channels, only: %i[index create], param: :slug
    get "channels/:slug",         to: "channels#show",    as: :channel
    patch "channels/:slug",       to: "channels#update"
    get "channels/:slug/context", to: "channels#context",  as: :channel_context

    post "channels/:channel_slug/messages", to: "messages#create", as: :channel_messages

    get  "channels/:channel_slug/members", to: "members#index", as: :channel_members
    post "channels/:channel_slug/members", to: "members#create"

    get  "channels/:channel_slug/skills", to: "skills#index",  as: :channel_skills
    post "channels/:channel_slug/skills", to: "skills#create"

    get  "channels/:channel_slug/memory", to: "memory#index",  as: :channel_memory
    post "channels/:channel_slug/memory", to: "memory#create"

    post  "channels/:channel_slug/runs", to: "runs#create", as: :channel_runs
    patch "runs/:id",          to: "runs#update",  as: :run
    post  "runs/:id/steps",    to: "runs#step",    as: :run_steps
    post  "runs/:id/plan",     to: "runs#plan",    as: :run_plan

    # What is waiting on a person, and the answer to one. The channel is in both
    # urls because a decision belongs to a room, and the room is who may answer.
    get  "channels/:channel_slug/decisions",     to: "decisions#index",  as: :channel_decisions
    post "channels/:channel_slug/decisions/:id", to: "decisions#answer", as: :channel_decision

    get  "channels/:channel_slug/artifacts", to: "artifacts#index",  as: :channel_artifacts
    post "runs/:run_id/artifacts",           to: "artifacts#create", as: :run_artifacts

    # The bytes behind an artifact, addressed by what they are. The channel is
    # in the url because a digest is not a permission — it names the same file
    # wherever it was stored.
    get "channels/:channel_slug/record/:sha256", to: "records#show", as: :channel_record
    # The journal as a listing (#220) — what a .workroom/ mirror reads.
    get "channels/:channel_slug/records", to: "records#index", as: :channel_records_listing
    post "runs/:id/messages", to: "runs#message", as: :run_messages
  end
    end

  # Last, and constrained. The router is in the page, so a path only the page knows
  # about has to come back as the page — but `/api` and `/auth` belong to clients
  # that need a real answer, and a 200 with an html body is the failure where a
  # client parses a login screen as an empty channel list and shows an empty room.
  #
  # Constrained on the path, not on `Accept`. A browser navigation does send
  # `text/html`, so negotiating would work — right up to the client that sends
  # `*/*`, where the page becomes a 404 and only in production. The path is what
  # this decision is actually about.
  #
  # A dotted last segment is an asset, and a missing one must stay missing: a
  # request for a hashed bundle that is no longer there has to fail as a 404, not
  # arrive as html the browser then tries to parse as javascript.
  get "(*path)", to: "web#show", constraints: ->(req) {
    !req.path.start_with?("/api", "/auth", "/up", "/cable") &&
      !File.basename(req.path).include?(".")
  }
end
