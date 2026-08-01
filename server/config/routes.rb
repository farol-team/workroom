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
    get  "me", to: "auth#me", as: :me

    # One MCP endpoint per channel — the channel in the url is the scope.
    post "rail/:slug", to: "rail#call", as: :rail

    resources :workspaces, only: %i[index create]

    get "channel-templates", to: "channels#templates", as: :channel_templates
    resources :channels, only: %i[index create], param: :slug
    get "channels/:slug",         to: "channels#show",    as: :channel
    get "channels/:slug/context", to: "channels#context",  as: :channel_context

    post "channels/:channel_slug/messages", to: "messages#create", as: :channel_messages

    get  "channels/:channel_slug/members", to: "members#index", as: :channel_members

    get  "channels/:channel_slug/skills", to: "skills#index",  as: :channel_skills
    post "channels/:channel_slug/skills", to: "skills#create"

    get  "channels/:channel_slug/memory", to: "memory#index",  as: :channel_memory
    post "channels/:channel_slug/memory", to: "memory#create"

    post  "channels/:channel_slug/runs", to: "runs#create", as: :channel_runs
    patch "runs/:id",          to: "runs#update",  as: :run
    post  "runs/:id/steps",    to: "runs#step",    as: :run_steps
    post  "runs/:id/plan",     to: "runs#plan",    as: :run_plan

    get  "channels/:channel_slug/artifacts", to: "artifacts#index",  as: :channel_artifacts
    post "runs/:run_id/artifacts",           to: "artifacts#create", as: :run_artifacts
    post "runs/:id/messages", to: "runs#message", as: :run_messages
  end
    end
end
