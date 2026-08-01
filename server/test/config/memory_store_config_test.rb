require "test_helper"

# The store was chosen by whether one variable happened to be set, and a
# production server deployed without it accumulated what every room knows in
# PostgreSQL without saying so. That happened — the first deploy of this server
# came up exactly that way, and was caught by looking rather than by being told.
#
# The fallback itself is right where it belongs: it is why bin/prototype runs
# with no credentials and why the suite runs in CI against no external service.
# Neither of those is production, and production is no longer offered it — a
# store that retrieves by substring is not a way to run a workspace, so the
# refusal has no way out rather than a stated one.
class MemoryStoreConfigTest < ActiveSupport::TestCase
  # The initializer runs under to_prepare with the real environment, so the
  # decision is extracted and exercised directly. Testing it through boot would
  # mean booting a second application per case.
  def choose(env)
    Memory::Selection.new(env).store_class
  end

  test "a context store is used when one is configured" do
    %w[development production].each do |rails_env|
      assert_equal Memory::OpenViking,
        choose("RAILS_ENV" => rails_env, "OPENVIKING_URL" => "http://context:8000"),
        "#{rails_env} must use the configured context store"
    end
  end

  test "outside production, no context store is PostgreSQL and that is the point" do
    %w[development test].each do |rails_env|
      assert_equal Memory::Local, choose("RAILS_ENV" => rails_env),
        "#{rails_env} must fall back — bin/prototype runs with no credentials, and CI has no store"
    end
  end

  test "a production server without a context store refuses to start" do
    error = assert_raises(RuntimeError) { choose("RAILS_ENV" => "production") }

    assert_match "OPENVIKING_URL", error.message,
      "the refusal must name the variable that is missing, or it sends somebody reading source"
  end

  test "PostgreSQL in production cannot be chosen, by any spelling" do
    # The way out was real, and is gone. A deploy that still carries the
    # variable must get the same refusal as one that carries nothing: silently
    # honouring a removed setting is how a workspace lands on the wrong store a
    # second time, and this time it would have been asked for.
    %w[true 1 yes on].each do |spelling|
      assert_raises RuntimeError, "WORKROOM_MEMORY_IN_POSTGRES=#{spelling} must not be a way to run a workspace" do
        choose("RAILS_ENV" => "production", "WORKROOM_MEMORY_IN_POSTGRES" => spelling)
      end
    end
  end

  test "building an image is not booting a server" do
    # Precompiling assets loads the production environment inside the image,
    # where no store is configured and none can be. Rails marks that case with
    # SECRET_KEY_BASE_DUMMY — the difference between an image that cannot be
    # built and a server that will not start misconfigured.
    assert_equal Memory::Local,
      choose("RAILS_ENV" => "production", "SECRET_KEY_BASE_DUMMY" => "1"),
      "asset precompilation must not require a context store"
  end
end
