require "test_helper"

# Serving the page the room is drawn in.
#
# The router is in the page, so the server has to answer paths it has never heard of
# with the same document — otherwise a reload anywhere but `/` is a 404. The whole
# risk of that is the opposite mistake: an API path that does not exist must not come
# back as a 200 with an html page, because a client parsing a login screen as an
# empty channel list shows an empty room and blames the workspace.
class WebControllerTest < ActionDispatch::IntegrationTest
  setup do
    @built = Rails.root.join("..", "desktop", "dist-web", "index.html").expand_path
    skip "the web bundle is not built here" unless @built.exist?
  end

  test "the room is at the root" do
    get "/"

    assert_response :success
    assert_equal "text/html", response.media_type
  end

  test "a path only the page knows about is still the page" do
    get "/c/sales"

    assert_response :success
    assert_equal "text/html", response.media_type
  end

  # Not negotiated. A browser navigation sends `text/html` and would have worked
  # either way; a client that sends `*/*` would have got a 404, and only in
  # production, where nobody is looking at a terminal.
  test "the page does not depend on what the client said it accepts" do
    get "/c/sales", headers: { "Accept" => "*/*" }

    assert_response :success
  end

  # A bundle that is no longer there has to stay gone. Answered with the page, the
  # browser parses html as javascript and reports a syntax error in a file it
  # cannot show you.
  test "an asset that is not there is missing, not the page" do
    get "/assets/index-longgone.js"

    assert_response :not_found
  end

  # Each of these is a client's request, and each has a right to a real answer.
  #
  # "Not html" is the wrong test twice over: an unrouted path renders Rails' own
  # error page, and `/up` renders the health check's — both html, both correct. The
  # thing that must never come back is *this* document, which a client would parse as
  # a login screen where a channel list should have been, and then show an empty room.
  test "the api and the provider are never answered with the room" do
    room = @built.read[/<title>[^<]*<\/title>/]

    %w[/api/v1/nonsense /api/v1/channels /auth/nonsense /up /cable].each do |path|
      get path

      assert_not_includes response.body, room, "#{path} must not be swallowed by the page"
    end
  end
end
