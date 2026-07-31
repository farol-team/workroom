require_relative "boot"

require "rails/all"

# Require the gems listed in Gemfile, including any gems
# you've limited to :test, :development, or :production.
Bundler.require(*Rails.groups)

module Workroom
  # The client and the server ship together and can drift apart. Neither can say
  # so without knowing what it is itself.
  VERSION = "0.1.0".freeze

  class Application < Rails::Application
    # Initialize configuration defaults for originally generated Rails version.
    config.load_defaults 8.1

    # Please, add to the `ignore` list any other `lib` subdirectories that do
    # not contain `.rb` files, or that should not be reloaded or eager loaded.
    # Common ones are `templates`, `generators`, or `middleware`, for example.
    config.autoload_lib(ignore: %w[assets tasks])

    # Development sign-in takes any address with no proof. It is on where it is
    # meant to be and off everywhere else, because a forgotten development path
    # is an open door.
    config.x.dev_signin = ENV.fetch("WORKROOM_DEV_SIGNIN", Rails.env.local? ? "1" : "0") == "1"

    # Configuration for the application, engines, and railties goes here.
    #
    # These settings can be overridden in specific environments using the files
    # in config/environments, which are processed later.
    #
    # config.time_zone = "Central Time (US & Canada)"
    # config.eager_load_paths << Rails.root.join("extras")
  end
end
