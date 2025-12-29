package com.example;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.stream.Stream;

import org.junit.jupiter.api.AfterAll;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.Network;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.lifecycle.Startables;
import org.testcontainers.utility.DockerImageName;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

class ConductorStackTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final HttpClient client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();

    private static final Network network = Network.newNetwork();

    private static final GenericContainer<?> redis = new GenericContainer<>(DockerImageName.parse("redis:6.2.3-alpine"))
            .withNetwork(network)
            .withNetworkAliases("conductor-redis", "rs")
            .withExposedPorts(6379)
            .waitingFor(Wait.forListeningPort())
            .withStartupTimeout(Duration.ofMinutes(2));

    private static final GenericContainer<?> elasticsearch = new GenericContainer<>(DockerImageName.parse("docker.elastic.co/elasticsearch/elasticsearch:7.17.11"))
            .withNetwork(network)
            .withNetworkAliases("conductor-elasticsearch", "es")
            .withEnv("ES_JAVA_OPTS", "-Xms512m -Xmx1024m")
            .withEnv("xpack.security.enabled", "false")
            .withEnv("discovery.type", "single-node")
            .withExposedPorts(9200)
            .waitingFor(Wait.forHttp("/_cluster/health").forPort(9200).forStatusCode(200))
            .withStartupTimeout(Duration.ofMinutes(5));

    private static final GenericContainer<?> conductor = new GenericContainer<>(DockerImageName.parse("conductor:server"))
            .withNetwork(network)
            .withNetworkAliases("conductor-server")
            .withEnv("CONFIG_PROP", "config-redis.properties")
            .withEnv("JAVA_OPTS", "-Dpolyglot.engine.WarnInterpreterOnly=false")
            .withExposedPorts(8080)
            .waitingFor(Wait.forHttp("/health").forPort(8080).forStatusCode(200))
            .withStartupTimeout(Duration.ofMinutes(5));

    @BeforeAll
    static void startStack() {
        Startables.deepStart(Stream.of(redis, elasticsearch)).join();
        conductor.start();
    }

    @AfterAll
    static void stopStack() {
        conductor.stop();
        elasticsearch.stop();
        redis.stop();
        network.close();
    }

    @Test
    void healthEndpointReturnsContent() throws Exception {
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl() + "/health"))
                .timeout(Duration.ofSeconds(30))
                .GET()
                .build();

        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());

        assertEquals(200, response.statusCode());
        assertFalse(response.body().isBlank(), "Health endpoint returned no content");
    }

    @Test
    void metadataTaskDefsReturnsArray() throws Exception {
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl() + "/api/metadata/taskdefs"))
                .timeout(Duration.ofSeconds(30))
                .GET()
                .build();

        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, response.statusCode());

        JsonNode json = MAPPER.readTree(response.body());
        assertTrue(json.isArray(), "Expected JSON array");
    }

    @Test
    void createWorkflowThenFetchTask() throws Exception {
        String suffix = UUID.randomUUID().toString().substring(0, 8);
        String taskName = "demo_task_" + suffix;
        String workflowName = "demo_wf_" + suffix;

        // Register task definition
        JsonNode taskDef = MAPPER.createObjectNode()
                .put("name", taskName)
                .put("retryCount", 1)
                .put("retryDelaySeconds", 0)
                .put("timeoutSeconds", 5000)
                .put("timeoutPolicy", "TIME_OUT_WF")
                .put("ownerEmail", "devnull@example.com");
        JsonNode taskDefs = MAPPER.createArrayNode().add(taskDef);

        HttpResponse<String> registerTaskResp = postJson("/api/metadata/taskdefs", taskDefs);
        assert2xx(registerTaskResp, "TaskDef registration failed");

        // Register workflow definition that uses the task
        JsonNode workflowDef = MAPPER.createObjectNode()
                .put("name", workflowName)
                .put("version", 1)
                .put("schemaVersion", 2)
                .put("ownerEmail", "devnull@example.com")
                .set("tasks", MAPPER.createArrayNode().add(
                        MAPPER.createObjectNode()
                                .put("name", taskName)
                                .put("taskReferenceName", "t1")
                                .put("type", "SIMPLE")
                ));

        HttpResponse<String> registerWorkflowResp = postJson("/api/metadata/workflow", workflowDef);
        assert2xx(registerWorkflowResp, "Workflow registration failed");

        // Start workflow instance
        HttpResponse<String> startResp = postJson("/api/workflow/" + workflowName + "?version=1", MAPPER.createObjectNode());
        assert2xx(startResp, "Workflow start failed");
        String workflowId = stripQuotes(startResp.body());
        assertFalse(workflowId.isBlank(), "Workflow id missing");

        // Poll workflow details until tasks are populated
        JsonNode workflow = waitForWorkflowWithTasks(workflowId);

        assertEquals(workflowName, workflow.path("workflowName").asText(), "Workflow name mismatch");
        JsonNode tasks = workflow.path("tasks");
        assertTrue(tasks.isArray() && tasks.size() > 0, "Expected tasks in workflow");
        JsonNode firstTask = tasks.get(0);
        assertEquals(taskName, firstTask.path("taskDefName").asText(), "Task name mismatch");
        String status = firstTask.path("status").asText();
        assertTrue(List.of("SCHEDULED", "IN_PROGRESS", "COMPLETED").contains(status), "Unexpected task status: " + status);
    }

    private static void assert2xx(HttpResponse<String> resp, String message) {
        int code = resp.statusCode();
        assertTrue(code >= 200 && code < 300, message + " (status " + code + "): " + resp.body());
    }

    private static HttpResponse<String> postJson(String path, Object body) throws Exception {
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl() + path))
                .timeout(Duration.ofSeconds(30))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(MAPPER.writeValueAsString(body)))
                .build();
        return client.send(request, HttpResponse.BodyHandlers.ofString());
    }

    private static JsonNode waitForWorkflowWithTasks(String workflowId) throws Exception {
        int attempts = 10;
        for (int i = 0; i < attempts; i++) {
            HttpResponse<String> resp = client.send(HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl() + "/api/workflow/" + workflowId + "?includeTasks=true"))
                    .timeout(Duration.ofSeconds(30))
                    .GET()
                    .build(), HttpResponse.BodyHandlers.ofString());

            if (resp.statusCode() == 200) {
                JsonNode wf = MAPPER.readTree(resp.body());
                JsonNode tasks = wf.path("tasks");
                if (tasks.isArray() && tasks.size() > 0) {
                    return wf;
                }
            }
            Thread.sleep(1000);
        }
        throw new AssertionError("Workflow tasks not available within timeout");
    }

    private static String stripQuotes(String text) {
        if (text == null) {
            return "";
        }
        String trimmed = text.trim();
        if (trimmed.startsWith("\"") && trimmed.endsWith("\"") && trimmed.length() >= 2) {
            return trimmed.substring(1, trimmed.length() - 1);
        }
        return trimmed;
    }

    private static String baseUrl() {
        return "http://" + conductor.getHost() + ":" + conductor.getMappedPort(8080);
    }
}
