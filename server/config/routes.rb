Rails.application.routes.draw do
  get "up" => "rails/health#show", as: :rails_health_check

  namespace :api do
    post "auth", to: "auth#create"

    # One MCP endpoint per channel — the channel in the url is the scope.
    post "rail/:slug", to: "rail#call", as: :rail

    resources :channels, only: %i[index create], param: :slug
    get "channels/:slug",         to: "channels#show",    as: :channel
    get "channels/:slug/context", to: "channels#context",  as: :channel_context

    post "channels/:channel_slug/messages", to: "messages#create", as: :channel_messages

    get  "channels/:channel_slug/memory", to: "memory#index",  as: :channel_memory
    post "channels/:channel_slug/memory", to: "memory#create"

    post  "channels/:channel_slug/runs", to: "runs#create", as: :channel_runs
    patch "runs/:id",          to: "runs#update",  as: :run
    post  "runs/:id/steps",    to: "runs#step",    as: :run_steps
    post  "runs/:id/messages", to: "runs#message", as: :run_messages
  end
end
